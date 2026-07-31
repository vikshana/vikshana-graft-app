import type { ToolExecution } from '../types/llm.types';
import { extractDashboardFromGetByUid } from './programmaticDashboardClone';
import { callMcpTool } from './mcpToolClient';
import type { McpClient } from './dashboardChunkedUpdate';
import { normalizeUpdateDashboardArgs } from './updateDashboardArgs';
import { listDashboardPanels, type DashboardPanelEntry } from './panelDiscovery';
import { parseSearchHitsFromMcpText } from './dashboardSearchParse';
import { isMachineId } from './dashboardCloneParse';
import { inferMachineIdFromDashboardTitle } from './programmaticDashboardResolve';
import { resolveInfluxDatasourceUid } from './prometheusDiscovery';
import { repairInfluxFluxPanel, sanitizeInfluxFluxPanel } from './sanitizeInfluxFluxPanel';
import type { AddPeerBandPanelRequest } from './peerBandPanelAddParse';
import { resolvePeerBandMetricFields } from './peerBandPanelAddParse';
import {
    buildPeerBandPanel,
    findAnyFluxReferencePanel,
    peerBandQueryUsesUnionTemplate,
    targetQueryText,
    getPanelTargetList,
} from './fluxPeerBandFix';

type PanelRecord = Record<string, unknown>;

export interface PeerBandPanelResult {
    ok: boolean;
    error?: string;
    toolExecutions: ToolExecution[];
    dashboardUid?: string;
    dashboardTitle?: string;
    version?: number;
    panelTitle?: string;
    panelId?: number;
    moduleNumber?: number;
    peerModules?: number[];
    actualField?: string;
    updatedExisting?: boolean;
}

function pendingTool(name: string): ToolExecution {
    return { name, status: 'pending' };
}

function finishTool(
    step: ToolExecution,
    outcome: { ok: boolean; error?: string; summary?: string }
): ToolExecution {
    return {
        ...step,
        status: outcome.ok ? 'success' : 'error',
        error: outcome.error,
        summary: outcome.summary,
    };
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

function influxUidFromDashboard(panels: unknown): string | undefined {
    const ref = findAnyFluxReferencePanel(Array.isArray(panels) ? panels : []);
    const uid = ref?.targetA?.datasource;
    if (uid && typeof uid === 'object' && 'uid' in (uid as Record<string, unknown>)) {
        return String((uid as { uid: string }).uid);
    }
    return undefined;
}

async function resolveDashboard(
    mcpClient: McpClient,
    opts: { dashboardUid?: string; dashboardTitle?: string; machineId?: string },
    toolExecutions: ToolExecution[]
): Promise<{ uid?: string; title?: string; error?: string }> {
    if (opts.dashboardUid) {
        return { uid: opts.dashboardUid };
    }
    const searchTitle = opts.dashboardTitle ?? opts.machineId;
    if (!searchTitle) {
        return { error: 'Need dashboard uid or title.' };
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
        hits.find((h) => opts.machineId && h.title?.includes(opts.machineId)) ??
        hits[0];
    if (!match?.uid) {
        return { error: `No dashboard found for "${searchTitle}".` };
    }
    return { uid: match.uid, title: match.title };
}

async function loadDashboard(
    mcpClient: McpClient,
    uid: string,
    toolExecutions: ToolExecution[]
): Promise<{ dashboard?: Record<string, unknown>; error?: string }> {
    const getStep = pendingTool('get_dashboard_by_uid');
    toolExecutions.push(getStep);
    const fetch = await callMcpTool(mcpClient, 'get_dashboard_by_uid', { uid });
    toolExecutions[toolExecutions.length - 1] = finishTool(getStep, fetch);
    if (!fetch.ok) {
        return { error: fetch.error ?? 'Could not load dashboard' };
    }
    const extracted = extractDashboardFromGetByUid(fetch.text);
    if (!extracted?.dashboard) {
        return { error: 'Could not parse dashboard JSON' };
    }
    return { dashboard: extracted.dashboard };
}

async function saveDashboard(
    mcpClient: McpClient,
    proposed: Record<string, unknown>,
    toolExecutions: ToolExecution[]
): Promise<{ ok: boolean; version?: number; error?: string }> {
    const updateStep = pendingTool('update_dashboard');
    toolExecutions.push(updateStep);
    const args = normalizeUpdateDashboardArgs({ dashboard: proposed });
    const update = await callMcpTool(mcpClient, 'update_dashboard', args);
    toolExecutions[toolExecutions.length - 1] = finishTool(updateStep, update);
    if (!update.ok) {
        return { ok: false, error: update.error ?? 'update_dashboard failed' };
    }
    const versionMatch = update.text?.match(/version[:\s]+(\d+)/i);
    return { ok: true, version: versionMatch ? parseInt(versionMatch[1], 10) : undefined };
}

function verifyPeerBandPanel(
    panel: PanelRecord | undefined,
    expectedTitle: string,
    expectedActualField?: string
): string | undefined {
    if (!panel) {
        return `Saved dashboard is missing panel "${expectedTitle}".`;
    }
    const targets = getPanelTargetList(panel);
    if (targets.length < 4) {
        return `Panel "${expectedTitle}" has ${targets.length} query target(s); expected 4 (Actual, Peer Mean, Upper/Lower Bound).`;
    }
    const queries = targets.map((t) => targetQueryText(t));
    if (!queries.every((q) => /\bfrom\s*\(\s*bucket:/i.test(q))) {
        return `Panel "${expectedTitle}" is missing Influx Flux queries (got PromQL or empty targets — no data).`;
    }
    const peerQueries = queries.slice(1);
    if (!peerQueries.some((q) => peerBandQueryUsesUnionTemplate(q))) {
        return `Panel "${expectedTitle}" peer queries lack union(tables:) peer branches — bands will not compute.`;
    }
    if (!queries.some((q) => /2\.0\s*\*\s*std|2\s*\*\s*std/i.test(q) || /math\.sqrt/i.test(q))) {
        return `Panel "${expectedTitle}" is missing ±2σ math in Flux (Upper/Lower Peer Bounds).`;
    }
    if (expectedActualField && !queries[0]?.includes(expectedActualField)) {
        return (
            `Panel "${expectedTitle}" Actual query does not use field \`${expectedActualField}\` ` +
            `(wrong metric family — e.g. Current instead of Pressure).`
        );
    }
    return undefined;
}

export async function runProgrammaticAddPeerBandPanel(
    mcpClient: McpClient,
    request: AddPeerBandPanelRequest
): Promise<PeerBandPanelResult> {
    const toolExecutions: ToolExecution[] = [];
    const resolved = await resolveDashboard(mcpClient, request, toolExecutions);
    if (!resolved.uid) {
        return { ok: false, error: resolved.error, toolExecutions };
    }
    const loaded = await loadDashboard(mcpClient, resolved.uid, toolExecutions);
    if (!loaded.dashboard) {
        return { ok: false, error: loaded.error, toolExecutions, dashboardUid: resolved.uid };
    }

    const proposed = JSON.parse(JSON.stringify(loaded.dashboard)) as Record<string, unknown>;
    const entries = listDashboardPanels(proposed.panels);
    const dashboardTitle = typeof proposed.title === 'string' ? proposed.title : resolved.title;
    const machineId =
        request.machineId && isMachineId(request.machineId)
            ? request.machineId
            : inferMachineIdFromDashboardTitle(
                  typeof proposed.title === 'string' ? proposed.title : dashboardTitle
              );
    if (!machineId) {
        return {
            ok: false,
            error:
                'Could not determine machine id from the prompt or dashboard title ' +
                `(got "${dashboardTitle ?? ''}"). Include the machine id or use a title like "2505-200033 / Keysight".`,
            toolExecutions,
            dashboardUid: resolved.uid,
            dashboardTitle,
        };
    }
    const mod = request.moduleNumber;
    const peerModules =
        request.peerModules ?? [1, 2, 3, 4, 5, 6, 7, 8].filter((n) => n !== mod);
    const metric = resolvePeerBandMetricFields(mod, peerModules, request.metricKind ?? 'current');
    const title =
        request.panelTitle?.trim() ||
        `Module ${mod} ${metric.kind === 'pressure' ? 'Pressure' : metric.kind === 'flow' ? 'Flow' : metric.kind === 'voltage' ? 'Voltage' : 'Current'} — vs. Peer Band (Modules 1–4,6–8 Avg ± 2σ)`;

    const existing = entries.find((e) => e.title === title);
    const updatedExisting = Boolean(existing);

    const influxUid =
        influxUidFromDashboard(proposed.panels) ??
        (await resolveInfluxDatasourceUid(mcpClient, proposed.panels, toolExecutions));
    if (!influxUid) {
        return {
            ok: false,
            error:
                'No Influx datasource found (dashboard panels or Grafana datasources). ' +
                'Configure an InfluxDB datasource in Grafana, or add a working Flux panel on this dashboard, then retry.',
            toolExecutions,
            dashboardUid: resolved.uid,
            dashboardTitle,
        };
    }

    const raw = buildPeerBandPanel({
        machineId,
        moduleNumber: mod,
        influxDatasourceUid: influxUid,
        panelTitle: title,
        peerModules,
        actualField: metric.actualField,
        peerFields: metric.peerFields,
        unit: metric.unit,
        labels: {
            actual: `${metric.signalName} Actual`,
            peerMean: 'Peer Mean',
            upper: 'Upper Peer Bound (±2σ)',
            lower: 'Lower Peer Bound (±2σ)',
        },
    });
    const sanitized = sanitizeInfluxFluxPanel(raw) as PanelRecord;
    const repaired = repairInfluxFluxPanel(sanitized, proposed.panels as unknown[] | undefined);
    const newPanel = repaired.panel as PanelRecord;
    const panelId =
        existing?.panelId != null && Number.isFinite(existing.panelId)
            ? existing.panelId
            : maxPanelId(entries) + 1;
    newPanel.id = panelId;
    if (existing?.panel) {
        const prev = existing.panel as PanelRecord;
        if (prev.gridPos && typeof prev.gridPos === 'object') {
            newPanel.gridPos = prev.gridPos;
        }
    }

    if (!Array.isArray(proposed.panels)) {
        proposed.panels = [newPanel];
    } else if (existing) {
        const panels = proposed.panels as PanelRecord[];
        const idx = panels.findIndex((p) => {
            const id = typeof p.id === 'number' ? p.id : Number(p.id);
            return id === panelId || (typeof p.title === 'string' && p.title === title);
        });
        if (idx >= 0) {
            panels[idx] = newPanel;
        } else {
            panels.push(newPanel);
        }
    } else {
        (proposed.panels as PanelRecord[]).push(newPanel);
    }

    const saved = await saveDashboard(mcpClient, proposed, toolExecutions);
    if (!saved.ok) {
        return {
            ok: false,
            error: saved.error,
            toolExecutions,
            dashboardUid: resolved.uid,
            dashboardTitle,
        };
    }

    // Post-save verification — do not claim Done without reading the dashboard back.
    const verifiedLoad = await loadDashboard(mcpClient, resolved.uid, toolExecutions);
    if (!verifiedLoad.dashboard) {
        return {
            ok: false,
            error: `Save appeared to succeed but verification failed: ${verifiedLoad.error ?? 'reload failed'}`,
            toolExecutions,
            dashboardUid: resolved.uid,
            dashboardTitle,
        };
    }
    const verifiedEntries = listDashboardPanels(verifiedLoad.dashboard.panels);
    const verified = verifiedEntries.find((e) => e.title === title);
    const verifyError = verifyPeerBandPanel(
        verified?.panel as PanelRecord | undefined,
        title,
        metric.actualField
    );
    if (verifyError) {
        return {
            ok: false,
            error: verifyError,
            toolExecutions,
            dashboardUid: resolved.uid,
            dashboardTitle,
            panelTitle: title,
            panelId,
            actualField: metric.actualField,
        };
    }

    return {
        ok: true,
        toolExecutions,
        dashboardUid: resolved.uid,
        dashboardTitle,
        version: saved.version,
        panelTitle: title,
        panelId: verified?.panelId ?? panelId,
        moduleNumber: mod,
        peerModules,
        actualField: metric.actualField,
        updatedExisting,
    };
}

export function formatAddPeerBandPanelReply(result: PeerBandPanelResult, build: number): string {
    if (!result.ok) {
        return (
            `### Peer Band panel — failed (build ${build})\n\n` +
            `${result.error ?? 'Unknown error'}\n\n` +
            `Tip: name the metric in the title (e.g. Module 2 **Pressure** or Module 2 **Current**) so Graft uses the right Influx fields.`
        );
    }
    return (
        `### Peer Band panel — saved (build ${build})\n\n` +
        `- Dashboard: \`${result.dashboardUid}\` v${result.version ?? '?'}\n` +
        `- Panel: **${result.panelTitle}**` +
        (result.panelId != null ? ` (id ${result.panelId})` : '') +
        (result.updatedExisting ? ` _(updated existing)_` : '') +
        `\n` +
        `- Field: \`${result.actualField ?? '?'}\` · Module **${result.moduleNumber}** vs peers **[${(result.peerModules ?? []).join(', ')}]**\n` +
        `- Series: Actual, Peer Mean, Upper/Lower Peer Bound (±2σ) — **computed in Flux** (union + mean ± 2×stddev)`
    );
}
