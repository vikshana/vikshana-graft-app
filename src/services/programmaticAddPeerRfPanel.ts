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
    const influxUid =
        influxDatasourceUidFromDashboard(proposed.panels) ??
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
            machineId,
            moduleNumber,
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
    const version = versionMatch ? Number(versionMatch[1]) : undefined;

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
        return (
            `### Could not add peer-RF panel (Graft build ${buildNumber})\n\n` +
            `${result.error ?? 'Unknown error'}\n\n` +
            `Ensure the ML exporter has run **peer-RF backfill** (\`model=peer_rf\` in Influx) before bands appear.`
        );
    }
    const machineLine = result.machineId ? `- **Machine:** \`${result.machineId}\`\n` : '';
    const field =
        result.moduleNumber != null ? `Module${result.moduleNumber}_Current_A` : 'ModuleN_Current_A';
    return (
        `### Done (peer-RF panel added) (Graft build ${buildNumber})\n\n` +
        `- **Dashboard:** ${result.dashboardTitle ?? result.dashboardUid} (\`${result.dashboardUid}\`)\n` +
        `- **Panel:** ${result.panelTitle}\n` +
        machineLine +
        (result.version != null ? `- **Version:** ${result.version}\n` : '') +
        `\nHard-refresh (**Cmd+Shift+R**). Queries filter Influx \`ml_predictions\` where \`model=peer_rf\` and \`field=${field}\`. ` +
        `If the panel shows no data, the peer-RF exporter must have written bands for this machine/module — ` +
        `run peer-RF backfill for \`${result.machineId ?? 'MACHINE'}\` / \`${field}\`, then refresh. ` +
        `Compare with the **vs. Peer Band** Flux panel.`
    );
}
