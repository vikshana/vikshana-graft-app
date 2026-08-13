import type { ToolExecution } from '../types/llm.types';
import { extractDashboardFromGetByUid } from './programmaticDashboardClone';
import { callMcpTool } from './mcpToolClient';
import type { McpClient } from './dashboardChunkedUpdate';
import { stampDashboardForOverwrite } from './fluxQueryFix';
import { normalizeUpdateDashboardArgs } from './updateDashboardArgs';
import { listDashboardPanels, type DashboardPanelEntry } from './panelDiscovery';
import { repairInfluxFluxPanel, sanitizeInfluxFluxPanel } from './sanitizeInfluxFluxPanel';
import type { AddPeerRfPanelRequest } from './peerRfPanelAddParse';
import { peerRfPanelTitle } from './peerRfPanelAddParse';
import { parseSearchHitsFromMcpText } from './dashboardSearchParse';
import { isMachineId } from './dashboardCloneParse';
import { inferMachineIdFromDashboardTitle } from './programmaticDashboardResolve';
import { findAnyFluxReferencePanel, getPanelTargetList } from './fluxPeerBandFix';
import { resolveInfluxDatasourceUid } from './prometheusDiscovery';
import {
    formatPeerRfUnavailableExplanation,
    probePeerRfModelAvailability,
    resolveInfluxUidWithPeerRfBands,
    type PeerRfAvailabilityResult,
} from './peerRfModelAvailability';
import {
    enrollPeerRfMachine,
    fetchPeerRfControlHealth,
    fetchPeerRfMachineStatus,
} from './peerRfEnrollApi';

const PEER_RF_BAND_WAIT_MS = 60_000;
const PEER_RF_BAND_POLL_MS = 4_000;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Re-probe Influx (and optionally wait on exporter backfill) until bands appear or timeout. */
async function waitForPeerRfBands(opts: {
    influxDatasourceUid: string;
    machineId: string;
    moduleNumber: number;
    timeoutMs?: number;
    pollMs?: number;
}): Promise<{
    availability: PeerRfAvailabilityResult;
    backfillFinished: boolean;
    backfillError?: string;
    statusNote: string;
}> {
    const timeoutMs = opts.timeoutMs ?? PEER_RF_BAND_WAIT_MS;
    const pollMs = opts.pollMs ?? PEER_RF_BAND_POLL_MS;
    const deadline = Date.now() + timeoutMs;
    let availability = await probePeerRfModelAvailability(opts);
    let backfillFinished = false;
    let backfillError: string | undefined;
    let statusNote = '';

    while (!availability.available && Date.now() < deadline) {
        const status = await fetchPeerRfMachineStatus(opts.machineId);
        if (status.backfill?.running === false && status.backfill?.finishedAt) {
            backfillFinished = true;
            if (status.backfill.error) {
                backfillError = status.backfill.error;
                statusNote = `Exporter backfill finished with error: ${status.backfill.error}`;
            } else {
                statusNote = 'Exporter backfill finished.';
            }
            availability = await probePeerRfModelAvailability(opts);
            if (availability.available) {
                break;
            }
            // Hard failure from exporter — no point waiting for Influx lag.
            if (backfillError) {
                break;
            }
            // Keep polling until timeout: bands can lag finishedAt (Influx write delay).
        } else if (status.backfill?.running) {
            statusNote = 'Exporter backfill still running.';
        }
        await sleep(pollMs);
        availability = await probePeerRfModelAvailability(opts);
    }

    if (!availability.available && !statusNote) {
        const status = await fetchPeerRfMachineStatus(opts.machineId);
        if (status.backfill?.running) {
            statusNote = 'Exporter backfill still running.';
        } else if (status.backfill?.finishedAt) {
            backfillFinished = true;
            if (status.backfill.error) {
                backfillError = status.backfill.error;
                statusNote = `Exporter backfill finished with error: ${status.backfill.error}`;
            } else {
                statusNote = 'Exporter backfill finished.';
            }
        }
    }

    return { availability, backfillFinished, backfillError, statusNote };
}

type PanelRecord = Record<string, unknown>;

function datasourceUidOf(value: unknown): string | undefined {
    if (value && typeof value === 'object' && 'uid' in (value as Record<string, unknown>)) {
        const uid = (value as { uid?: unknown }).uid;
        return typeof uid === 'string' && uid ? uid : undefined;
    }
    return typeof value === 'string' && value ? value : undefined;
}

/** Prefer a Flux panel on this dashboard; otherwise leave undefined for Grafana list_datasources. */
function influxDatasourceUidFromDashboard(panels: unknown): string | undefined {
    const fluxRef = findAnyFluxReferencePanel(Array.isArray(panels) ? panels : []);
    if (fluxRef) {
        const fromTarget = datasourceUidOf(fluxRef.targetA?.datasource);
        if (fromTarget) {
            return fromTarget;
        }
        const fromPanel = datasourceUidOf(fluxRef.panel.datasource);
        if (fromPanel) {
            return fromPanel;
        }
    }
    const entries = listDashboardPanels(panels);
    for (const e of entries) {
        const panelDs = e.panel.datasource as { type?: string; uid?: string } | undefined;
        if (panelDs && /influx/i.test(panelDs.type ?? '') && panelDs.uid) {
            return panelDs.uid;
        }
        for (const target of getPanelTargetList(e.panel)) {
            const ds = (target as PanelRecord).datasource as { type?: string; uid?: string } | undefined;
            if (ds && /influx/i.test(ds.type ?? '') && ds.uid) {
                return ds.uid;
            }
        }
    }
    return undefined;
}

/** Fixture-aligned panel template (queries use model=peer_rf), scoped to the requested module. */
function buildPeerRfPanelTemplate(
    machineId: string,
    moduleNumber: number,
    influxDatasourceUid: string
): PanelRecord {
    const m = machineId.replace(/"/g, '\\"');
    const field = `Module${moduleNumber}_Current_A`;
    const actualLabel = `Module ${moduleNumber} (Actual)`;
    const bandFilter = `r.machine == "${m}" and r.field == "${field}" and r.model == "peer_rf"`;
    const actualFilter = `r.machine == "${m}" and r._field == "${field}"`;
    const ds = { type: 'influxdb', uid: influxDatasourceUid };
    return {
        id: null,
        type: 'timeseries',
        title: peerRfPanelTitle(moduleNumber),
        description:
            `RandomForest predicts Module ${moduleNumber} from its peer modules. Bands: ml_predictions with model=peer_rf.`,
        timezone: 'browser',
        datasource: ds,
        gridPos: { h: 10, w: 12, x: 0, y: 0 },
        fieldConfig: {
            defaults: {
                custom: { drawStyle: 'line', spanNulls: true, showPoints: 'never' },
                unit: 'amp',
            },
        },
        options: { legend: { displayMode: 'list', placement: 'bottom', showLegend: true } },
        targets: [
            {
                refId: 'A',
                datasource: ds,
                legendFormat: actualLabel,
                query: `from(bucket: v.bucket)\n  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)\n  |> filter(fn: (r) => ${actualFilter})\n  |> group()\n  |> keep(columns: ["_time", "_value"])\n  |> aggregateWindow(every: v.windowPeriod, fn: mean, createEmpty: false)\n  |> map(fn: (r) => ({ _time: r._time, _value: r._value, _field: "${actualLabel}" }))`,
                rawQuery: true,
                editorMode: 'code',
            },
            {
                refId: 'B',
                datasource: ds,
                legendFormat: 'Upper Bound (Peer RF)',
                query: `from(bucket: v.bucket)\n  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)\n  |> filter(fn: (r) => r._measurement == "ml_predictions")\n  |> filter(fn: (r) => ${bandFilter})\n  |> filter(fn: (r) => r._field == "upper")\n  |> group()\n  |> keep(columns: ["_time", "_value"])\n  |> aggregateWindow(every: 5m, fn: last, createEmpty: false)\n  |> fill(usePrevious: true)\n  |> map(fn: (r) => ({ _time: r._time, _value: r._value, _field: "Upper Bound (Peer RF)" }))`,
                rawQuery: true,
                editorMode: 'code',
            },
            {
                refId: 'C',
                datasource: ds,
                legendFormat: 'Lower Bound (Peer RF)',
                query: `from(bucket: v.bucket)\n  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)\n  |> filter(fn: (r) => r._measurement == "ml_predictions")\n  |> filter(fn: (r) => ${bandFilter})\n  |> filter(fn: (r) => r._field == "lower")\n  |> group()\n  |> keep(columns: ["_time", "_value"])\n  |> aggregateWindow(every: 5m, fn: last, createEmpty: false)\n  |> fill(usePrevious: true)\n  |> map(fn: (r) => ({ _time: r._time, _value: r._value, _field: "Lower Bound (Peer RF)" }))`,
                rawQuery: true,
                editorMode: 'code',
            },
            {
                refId: 'D',
                datasource: ds,
                legendFormat: 'Expected (Peer RF)',
                query: `from(bucket: v.bucket)\n  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)\n  |> filter(fn: (r) => r._measurement == "ml_predictions")\n  |> filter(fn: (r) => ${bandFilter})\n  |> filter(fn: (r) => r._field == "expected")\n  |> group()\n  |> keep(columns: ["_time", "_value"])\n  |> aggregateWindow(every: 5m, fn: last, createEmpty: false)\n  |> fill(usePrevious: true)\n  |> map(fn: (r) => ({ _time: r._time, _value: r._value, _field: "Expected (Peer RF)" }))`,
                rawQuery: true,
                editorMode: 'code',
            },
        ],
    };
}

export interface ProgrammaticAddPeerRfPanelResult {
    ok: boolean;
    error?: string;
    /** When set, reply should explain missing exporter config — not a generic save failure. */
    unavailableReason?: 'peer_rf_missing';
    /** Why bands were missing after enroll/probe (drives plain-English headline). */
    unavailableKind?: 'backfill_pending' | 'backfill_failed' | 'datasource_mismatch' | 'not_configured';
    toolExecutions: ToolExecution[];
    dashboardUid?: string;
    dashboardTitle?: string;
    panelTitle?: string;
    machineId?: string;
    moduleNumber?: number;
    version?: number;
}

function pendingTool(name: string): ToolExecution {
    return { name, status: 'pending' };
}

function finishTool(step: ToolExecution, outcome: { ok: boolean; error?: string; summary?: string }): ToolExecution {
    return { ...step, status: outcome.ok ? 'success' : 'error', error: outcome.error, summary: outcome.summary };
}

function findPanelByTitleContains(entries: DashboardPanelEntry[], needle: string): DashboardPanelEntry | undefined {
    const n = needle.toLowerCase();
    return entries.find((e) => e.title.toLowerCase().includes(n));
}

/** Post-save check — panel present with peer_rf Flux targets (not empty placeholder). */
function verifyPeerRfPanel(
    panel: PanelRecord | undefined,
    expectedTitle: string,
    machineId: string,
    field: string
): string | undefined {
    if (!panel) {
        return `Save reported success but panel "${expectedTitle}" is missing from the dashboard.`;
    }
    const targets = getPanelTargetList(panel);
    if (targets.length < 4) {
        return (
            `Panel "${expectedTitle}" has ${targets.length} query target(s); ` +
            `expected 4 (Actual, Upper, Lower, Expected).`
        );
    }
    const blob = JSON.stringify(targets);
    if (!blob.includes('peer_rf') || !blob.includes('ml_predictions')) {
        return `Panel "${expectedTitle}" is missing peer RandomForest Flux filters (model=peer_rf).`;
    }
    if (!blob.includes(machineId)) {
        return `Panel "${expectedTitle}" does not reference machine \`${machineId}\`.`;
    }
    if (!blob.includes(field)) {
        return `Panel "${expectedTitle}" does not reference field \`${field}\`.`;
    }
    return undefined;
}

function maxPanelId(entries: DashboardPanelEntry[]): number {
    let max = 0;
    for (const e of entries) {
        if (e.panelId != null && e.panelId > max) {
            max = e.panelId;
        }
    }
    return max;
}

function findModule5PeerBandPanel(entries: DashboardPanelEntry[]): DashboardPanelEntry | undefined {
    const m5 =
        entries.find((e) => /Module\s*5\b/i.test(e.title) && /vs\.\s*Peer\s*Band/i.test(e.title)) ??
        entries.find((e) => /Module\s*5\b/i.test(e.title) && /Peer\s*Band/i.test(e.title));
    if (m5) {
        return m5;
    }
    return (
        entries.find((e) => /vs\.\s*Peer\s*Band/i.test(e.title)) ??
        entries.find((e) => /Peer\s*Band/i.test(e.title))
    );
}

function gridPosBesidePeerBand(peerEntry: DashboardPanelEntry | undefined, entries: DashboardPanelEntry[]): {
    x: number;
    y: number;
    w: number;
    h: number;
} {
    const defaultW = 12;
    const defaultH = 10;
    if (peerEntry?.panel?.gridPos) {
        const gp = peerEntry.panel.gridPos as { x?: number; y?: number; w?: number; h?: number };
        const peerW = typeof gp.w === 'number' ? gp.w : 24;
        const peerH = typeof gp.h === 'number' ? gp.h : 12;
        const peerY = typeof gp.y === 'number' ? gp.y : 0;
        const peerX = typeof gp.x === 'number' ? gp.x : 0;
        // Full-width peer band → new row directly below; half-width → tile to the right.
        if (peerW >= 24) {
            return { x: 0, y: peerY + peerH, w: defaultW, h: defaultH };
        }
        const x = peerX + peerW;
        return { x: x >= 24 ? 0 : x, y: peerY, w: defaultW, h: defaultH };
    }
    let maxY = 0;
    for (const e of entries) {
        const gp = e.panel.gridPos as { y?: number; h?: number } | undefined;
        if (gp && typeof gp.y === 'number' && typeof gp.h === 'number') {
            maxY = Math.max(maxY, gp.y + gp.h);
        }
    }
    return { x: 0, y: maxY, w: defaultW, h: defaultH };
}

async function resolveDashboard(
    mcpClient: McpClient,
    request: AddPeerRfPanelRequest,
    toolExecutions: ToolExecution[]
): Promise<{ uid?: string; title?: string; error?: string }> {
    if (request.dashboardUid) {
        return { uid: request.dashboardUid };
    }
    const searchTitle = request.dashboardTitle ?? request.machineId;
    if (!searchTitle) {
        return { error: 'Need dashboard uid, title, or machine id.' };
    }
    const searchStep = pendingTool('search_dashboards');
    toolExecutions.push(searchStep);
    const searchResult = await callMcpTool(mcpClient, 'search_dashboards', { query: searchTitle });
    toolExecutions[toolExecutions.length - 1] = finishTool(searchStep, searchResult);
    if (!searchResult.ok) {
        return { error: searchResult.error ?? 'Dashboard search failed' };
    }
    const hits = parseSearchHitsFromMcpText(searchResult.text);
    const match =
        hits.find((h) => h.title?.includes(searchTitle)) ??
        hits.find((h) => (request.machineId && h.title?.includes(request.machineId)) || false) ??
        hits[0];
    if (!match?.uid) {
        return { error: `No dashboard found for "${searchTitle}".` };
    }
    return { uid: match.uid, title: match.title };
}

export async function runProgrammaticAddPeerRfPanel(
    mcpClient: McpClient,
    request: AddPeerRfPanelRequest
): Promise<ProgrammaticAddPeerRfPanelResult> {
    const toolExecutions: ToolExecution[] = [];
    const resolved = await resolveDashboard(mcpClient, request, toolExecutions);
    if (!resolved.uid) {
        return { ok: false, error: resolved.error, toolExecutions };
    }

    const getStep = pendingTool('get_dashboard_by_uid');
    toolExecutions.push(getStep);
    const fetch = await callMcpTool(mcpClient, 'get_dashboard_by_uid', { uid: resolved.uid });
    toolExecutions[toolExecutions.length - 1] = finishTool(getStep, fetch);
    if (!fetch.ok) {
        return { ok: false, error: fetch.error ?? 'Could not load dashboard', toolExecutions, dashboardUid: resolved.uid };
    }

    const extracted = extractDashboardFromGetByUid(fetch.text);
    if (!extracted?.dashboard) {
        return { ok: false, error: 'Could not parse dashboard JSON', toolExecutions, dashboardUid: resolved.uid };
    }

    const baseline = extracted.dashboard;
    const dashboardTitle = typeof baseline.title === 'string' ? baseline.title : resolved.title;
    const proposed = JSON.parse(JSON.stringify(baseline)) as Record<string, unknown>;
    const entries = listDashboardPanels(proposed.panels);

    const machineId =
        request.machineId && isMachineId(request.machineId)
            ? request.machineId
            : inferMachineIdFromDashboardTitle(dashboardTitle);
    if (!machineId) {
        return {
            ok: false,
            error:
                'Could not determine machine id from the prompt or dashboard title ' +
                `(got "${dashboardTitle ?? ''}"). Include the machine id (e.g. 2505-200033) or use a title like "2505-200033 / Keysight".`,
            toolExecutions,
            dashboardUid: resolved.uid,
            dashboardTitle,
        };
    }

    const moduleNumber = request.moduleNumber;
    if (moduleNumber == null) {
        return {
            ok: false,
            error:
                'Which module should the peer-RF panel use? Name it in the prompt (e.g. Module 2 Current — RandomForest vs Peers).',
            toolExecutions,
            dashboardUid: resolved.uid,
            dashboardTitle,
            machineId,
        };
    }

    const panelTitle = peerRfPanelTitle(moduleNumber);

    const existing = findPanelByTitleContains(entries, panelTitle);
    if (existing) {
        return {
            ok: false,
            error: `Panel "${panelTitle}" already exists (id ${existing.panelId ?? '?'}).`,
            toolExecutions,
            dashboardUid: resolved.uid,
            dashboardTitle,
            machineId,
            moduleNumber,
        };
    }

    const peerRef = findModule5PeerBandPanel(entries);
    const preferredInfluxUid =
        influxDatasourceUidFromDashboard(proposed.panels) ??
        (await resolveInfluxDatasourceUid(mcpClient, proposed.panels, toolExecutions));

    const field = `Module${moduleNumber}_Current_A`;
    const resolvedInflux = await resolveInfluxUidWithPeerRfBands({
        preferredUid: preferredInfluxUid,
        machineId,
        moduleNumber,
    });
    let influxUid = resolvedInflux.influxDatasourceUid;
    if (!influxUid) {
        return {
            ok: false,
            error:
                'No Influx datasource found (dashboard panels or Grafana datasources). ' +
                'Configure an InfluxDB datasource in Grafana, or add a working Flux panel on this dashboard, then retry.',
            toolExecutions,
            dashboardUid: resolved.uid,
            dashboardTitle,
            machineId,
            moduleNumber,
        };
    }

    let availability = resolvedInflux.availability;

    let enrollNote = '';
    if (!availability.available) {
        const health = await fetchPeerRfControlHealth();
        const controlReady = Boolean(health.ok || health.controlConfigured);
        const shouldEnroll = Boolean(request.enrollIfMissing || controlReady);

        if (shouldEnroll && controlReady) {
            const enrolled = await enrollPeerRfMachine(machineId, { backfill: true });
            if (!enrolled.ok) {
                return {
                    ok: false,
                    unavailableReason: 'peer_rf_missing',
                    unavailableKind: 'not_configured',
                    error:
                        formatPeerRfUnavailableExplanation({
                            machineId,
                            moduleNumber,
                            field,
                            probeError: availability.probeError,
                        }) +
                        `\n\n**Could not start setup automatically:** ${enrolled.error ?? 'unknown'}` +
                        (enrolled.status === 403
                            ? '\n(You need a Grafana **Admin** role for this.)'
                            : '') +
                        (enrolled.status === 503 || /not configured/i.test(enrolled.error ?? '')
                            ? '\nOps: set **peerRfControlUrl** and **peerRfControlToken** in Graft plugin settings.'
                            : ''),
                    toolExecutions,
                    dashboardUid: resolved.uid,
                    dashboardTitle,
                    machineId,
                    moduleNumber,
                    panelTitle,
                };
            }
            enrollNote = enrolled.alreadyEnrolled
                ? `Machine **${machineId}** was already set up for peer RandomForest.` +
                  (enrolled.backfillQueued ? ' A history fill was (re)queued.' : '')
                : `I started peer RandomForest setup for machine **${machineId}.**` +
                  (enrolled.backfillQueued ? ' A first-time history fill was queued.' : '');

            const waited = await waitForPeerRfBands({
                influxDatasourceUid: influxUid,
                machineId,
                moduleNumber,
            });
            availability = waited.availability;

            if (!availability.available) {
                // Re-rank datasources after backfill — local Influx may still be empty.
                const again = await resolveInfluxUidWithPeerRfBands({
                    preferredUid: influxUid,
                    machineId,
                    moduleNumber,
                });
                if (again.availability.available && again.influxDatasourceUid) {
                    availability = again.availability;
                    influxUid = again.influxDatasourceUid;
                }
            }

            if (!availability.available) {
                let unavailableKind: NonNullable<ProgrammaticAddPeerRfPanelResult['unavailableKind']>;
                let hint: string;
                if (waited.backfillError) {
                    unavailableKind = 'backfill_failed';
                    hint =
                        `\n\nThe history fill **failed** on the ML exporter:\n\n> ${waited.backfillError}\n\n` +
                        `Fix that exporter error (or ask ops), then re-run the same create prompt. ` +
                        `This is not a Grafana Influx URL mismatch.\n\n` +
                        `**Meanwhile:** Peer Band (±2σ) and Own History panels/alerts do **not** need this fill and can be created now.`;
                } else if (waited.backfillFinished) {
                    unavailableKind = 'datasource_mismatch';
                    hint =
                        `\n\nThe history fill reports finished, but Grafana still cannot see Module ${moduleNumber} predictions. ` +
                        `That usually means Grafana’s Influx datasource is pointed at the wrong host (not the data bridge). Ask ops to run \`scripts/sync-grafana-influx-to-bridge.sh\`.`;
                } else {
                    unavailableKind = 'backfill_pending';
                    hint =
                        `\n\nThe history fill is still running (first time for a machine can take up to a couple of hours). ` +
                        `Ask again with the same request once it finishes — setup is already done, you do not need to enroll again.\n\n` +
                        `**While you wait:** Peer Band (±2σ) and Own History panels/alerts do **not** need this fill and can be created now.`;
                }
                return {
                    ok: false,
                    unavailableReason: 'peer_rf_missing',
                    unavailableKind,
                    error: `${enrollNote}\n\nPredicted RandomForest bands for Module ${moduleNumber} (\`${field}\`) are not visible in Grafana yet.${hint}`,
                    toolExecutions,
                    dashboardUid: resolved.uid,
                    dashboardTitle,
                    machineId,
                    moduleNumber,
                    panelTitle,
                };
            }
        }
    }

    if (!availability.available) {
        return {
            ok: false,
            unavailableReason: 'peer_rf_missing',
            unavailableKind: 'not_configured',
            error: formatPeerRfUnavailableExplanation({
                machineId,
                moduleNumber,
                field,
                probeError: availability.probeError,
            }),
            toolExecutions,
            dashboardUid: resolved.uid,
            dashboardTitle,
            machineId,
            moduleNumber,
            panelTitle,
        };
    }

    const template = buildPeerRfPanelTemplate(machineId, moduleNumber, influxUid);
    const sanitized = sanitizeInfluxFluxPanel(template) as PanelRecord;
    const repaired = repairInfluxFluxPanel(sanitized, baseline.panels as unknown[] | undefined);
    const newPanel = repaired.panel as PanelRecord;
    newPanel.id = maxPanelId(entries) + 1;
    newPanel.gridPos = gridPosBesidePeerBand(peerRef, entries);

    const panels = proposed.panels;
    if (!Array.isArray(panels)) {
        proposed.panels = [newPanel];
    } else {
        panels.push(newPanel);
    }

    const saveStep = pendingTool('update_dashboard');
    toolExecutions.push(saveStep);
    const savePayload = normalizeUpdateDashboardArgs({
        dashboard: stampDashboardForOverwrite(baseline, proposed),
        overwrite: true,
        message: `Graft: add ${panelTitle}`,
    });
    const saveResult = await callMcpTool(mcpClient, 'update_dashboard', savePayload);
    toolExecutions[toolExecutions.length - 1] = finishTool(saveStep, saveResult);

    if (!saveResult.ok) {
        return {
            ok: false,
            error: saveResult.error ?? 'update_dashboard failed',
            toolExecutions,
            dashboardUid: resolved.uid,
            dashboardTitle,
            machineId,
            moduleNumber,
        };
    }

    const versionMatch = saveResult.text?.match(/"version"\s*:\s*(\d+)/);
    let version = versionMatch ? Number(versionMatch[1]) : undefined;

    const verifyStep = pendingTool('get_dashboard_by_uid');
    toolExecutions.push(verifyStep);
    const verifyFetch = await callMcpTool(mcpClient, 'get_dashboard_by_uid', { uid: resolved.uid });
    toolExecutions[toolExecutions.length - 1] = finishTool(verifyStep, verifyFetch);
    if (!verifyFetch.ok) {
        return {
            ok: false,
            error: `Save appeared to succeed but verification failed: ${verifyFetch.error ?? 'reload failed'}`,
            toolExecutions,
            dashboardUid: resolved.uid,
            dashboardTitle,
            machineId,
            moduleNumber,
            panelTitle,
        };
    }
    const verified = extractDashboardFromGetByUid(verifyFetch.text);
    if (!verified?.dashboard) {
        return {
            ok: false,
            error: 'Save appeared to succeed but verification could not parse the dashboard.',
            toolExecutions,
            dashboardUid: resolved.uid,
            dashboardTitle,
            machineId,
            moduleNumber,
            panelTitle,
        };
    }
    if (typeof verified.dashboard.version === 'number') {
        version = verified.dashboard.version;
    }
    const verifiedEntries = listDashboardPanels(verified.dashboard.panels);
    const verifiedPanel = findPanelByTitleContains(verifiedEntries, panelTitle);
    const verifyError = verifyPeerRfPanel(
        verifiedPanel?.panel as PanelRecord | undefined,
        panelTitle,
        machineId,
        field
    );
    if (verifyError) {
        return {
            ok: false,
            error: verifyError,
            toolExecutions,
            dashboardUid: resolved.uid,
            dashboardTitle,
            machineId,
            moduleNumber,
            panelTitle,
            version,
        };
    }

    return {
        ok: true,
        toolExecutions,
        dashboardUid: resolved.uid,
        dashboardTitle,
        panelTitle,
        machineId,
        moduleNumber,
        version,
    };
}

export function formatAddPeerRfPanelReply(result: ProgrammaticAddPeerRfPanelResult, buildNumber: number): string {
    if (!result.ok) {
        if (result.unavailableReason === 'peer_rf_missing') {
            const headline =
                result.unavailableKind === 'backfill_pending'
                    ? `### RandomForest vs Peers is still preparing (Graft build ${buildNumber})`
                    : result.unavailableKind === 'backfill_failed'
                      ? `### RandomForest history fill failed (Graft build ${buildNumber})`
                      : result.unavailableKind === 'datasource_mismatch'
                        ? `### RandomForest data not visible to Grafana yet (Graft build ${buildNumber})`
                        : `### RandomForest vs Peers is not ready yet (Graft build ${buildNumber})`;
            return (
                `${headline}\n\n` +
                `${result.error ?? 'Predicted peer RandomForest bands are not available yet.'}\n\n` +
                `- **Dashboard:** ${result.dashboardTitle ?? result.dashboardUid ?? '?'} (\`${result.dashboardUid ?? ''}\`)\n` +
                (result.machineId ? `- **Machine:** \`${result.machineId}\`\n` : '') +
                (result.panelTitle ? `- **Requested panel:** ${result.panelTitle}\n` : '') +
                `\n**No panel was added** — Graft will not create empty placeholder charts.`
            );
        }
        return (
            `### Could not add RandomForest vs Peers panel (Graft build ${buildNumber})\n\n` +
            `${result.error ?? 'Unknown error'}\n`
        );
    }
    const machineLine = result.machineId ? `- **Machine:** \`${result.machineId}\`\n` : '';
    return (
        `### Done — RandomForest vs Peers panel added (Graft build ${buildNumber})\n\n` +
        `- **Dashboard:** ${result.dashboardTitle ?? result.dashboardUid} (\`${result.dashboardUid}\`)\n` +
        `- **Panel:** ${result.panelTitle}\n` +
        machineLine +
        (result.version != null ? `- **Version:** ${result.version}\n` : '') +
        `\nHard-refresh (**Cmd+Shift+R**), open the dashboard, and confirm Module Actual plus Expected / Upper / Lower.`
    );
}
