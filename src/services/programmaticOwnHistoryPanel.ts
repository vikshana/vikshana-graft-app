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
import type {
    AddOwnHistoryPanelRequest,
    BulkOwnHistoryPanelCopyRequest,
} from './ownHistoryPanelParse';
import { catalogOwnHistorySignal } from './ownHistoryPanelParse';
import {
    canonicalOwnHistoryTitle,
    canonicalOwnHistoryTitleForLabel,
    isOwnHistoryPanel,
    normalizeLegacyModulePanelTitle,
} from './modulePanelTitles';
import { parseModuleNumberFromTitle } from './modulePanelReorderParse';
import {
    computeModulePanelGridPositions,
    MODULE_PANEL_GRID,
} from './programmaticModulePanelReorder';
import { findAnyFluxReferencePanel, getPanelTargetList, targetQueryText } from './fluxPeerBandFix';

type PanelRecord = Record<string, unknown>;

const LEGEND_SUFFIX = (
    label: string
) =>
    `|> map(fn: (r) => ({ _time: r._time, _value: r._value, _field: "${label}" }))\n` +
    `  |> map(fn: (r) => ({ r with _field: "${label}" }))\n` +
    `  |> keep(columns: ["_time", "_value", "_field"])`;

interface OwnHistorySignal {
    machineId: string;
    field: string;
    title: string;
    signalName: string;
    unit: string;
    influxDatasourceUid: string;
}

function buildOwnHistoryPanelForSignal(signal: OwnHistorySignal): PanelRecord {
    const { machineId, field, title, signalName, unit, influxDatasourceUid } = signal;
    const m = machineId.replace(/"/g, '\\"');
    const filter = `r.machine == "${m}" and r._field == "${field}"`;
    const ds = { uid: influxDatasourceUid };
    const actualLabel = `${signalName} (Actual)`;
    const meanLabel = 'Historical Mean';
    const upperLabel = 'Upper Bound (±2σ)';
    const lowerLabel = 'Lower Bound (±2σ)';

    const baseRange = `from(bucket: v.bucket)\n  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)\n  |> filter(fn: (r) => ${filter})`;
    const mean1h = `${baseRange}\n  |> group()\n  |> aggregateWindow(every: 1h, fn: mean, createEmpty: false)`;

    const buildBoundQuery = (sign: '+' | '-', label: string): string => {
        const op = sign === '+' ? '+' : '-';
        const esc = label.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        // Compute mean±2σ and set _field in ONE map so legend repair cannot strip the math
        // (stripFluxLegendSuffix used to remove any trailing map, replacing bands with r._value).
        return (
            `base = ${baseRange}\n` +
            `  |> group()\n\n` +
            `meanTable = base\n` +
            `  |> aggregateWindow(every: 1h, fn: mean, createEmpty: false)\n` +
            `  |> set(key: "stat", value: "mean")\n\n` +
            `stdTable = base\n` +
            `  |> aggregateWindow(every: 1h, fn: stddev, createEmpty: false)\n` +
            `  |> set(key: "stat", value: "std")\n\n` +
            `union(tables: [meanTable, stdTable])\n` +
            `  |> pivot(rowKey: ["_time"], columnKey: ["stat"], valueColumn: "_value")\n` +
            `  |> map(fn: (r) => ({ _time: r._time, _value: r.mean ${op} (2.0 * r.std), _field: "${esc}" }))\n` +
            `  |> keep(columns: ["_time", "_value", "_field"])`
        );
    };

    const upperQuery = buildBoundQuery('+', upperLabel);
    const lowerQuery = buildBoundQuery('-', lowerLabel);

    return {
        id: null,
        type: 'timeseries',
        title,
        description:
            `${signalName} actual vs **its own** rolling 1h mean ± **2σ** (Influx Flux). ` +
            'Not RandomForest / not ml_predictions / not peer modules.',
        timezone: 'browser',
        datasource: ds,
        gridPos: { h: MODULE_PANEL_GRID.h, w: MODULE_PANEL_GRID.w, x: 0, y: 0 },
        fieldConfig: {
            defaults: {
                custom: { drawStyle: 'line', spanNulls: true, showPoints: 'never' },
                unit,
            },
        },
        options: { legend: { displayMode: 'list', placement: 'bottom', showLegend: true } },
        targets: [
            {
                refId: 'A',
                datasource: ds,
                legendFormat: actualLabel,
                query:
                    `${baseRange}\n  |> aggregateWindow(every: v.windowPeriod, fn: mean, createEmpty: false)\n  ${LEGEND_SUFFIX(actualLabel)}`,
                rawQuery: true,
                editorMode: 'code',
            },
            {
                refId: 'B',
                datasource: ds,
                legendFormat: meanLabel,
                query: `${mean1h}\n  ${LEGEND_SUFFIX(meanLabel)}`,
                rawQuery: true,
                editorMode: 'code',
            },
            {
                refId: 'C',
                datasource: ds,
                legendFormat: upperLabel,
                query: upperQuery,
                rawQuery: true,
                editorMode: 'code',
            },
            {
                refId: 'D',
                datasource: ds,
                legendFormat: lowerLabel,
                query: lowerQuery,
                rawQuery: true,
                editorMode: 'code',
            },
        ],
    };
}

function buildOwnHistoryPanel(
    machineId: string,
    moduleNumber: number,
    influxDatasourceUid: string,
    panelTitle?: string
): PanelRecord {
    return buildOwnHistoryPanelForSignal({
        machineId,
        field: `Module${moduleNumber}_Current_A`,
        title: panelTitle?.trim() || canonicalOwnHistoryTitle(moduleNumber),
        signalName: `Module ${moduleNumber}`,
        unit: 'amp',
        influxDatasourceUid,
    });
}

interface ResolvedSignalSource {
    field: string;
    machine?: string;
    unit?: string;
    datasourceUid?: string;
}

function datasourceUidOf(value: unknown): string | undefined {
    if (value && typeof value === 'object' && 'uid' in (value as Record<string, unknown>)) {
        const uid = (value as { uid?: unknown }).uid;
        return typeof uid === 'string' ? uid : undefined;
    }
    return typeof value === 'string' ? value : undefined;
}

/**
 * For a non-module signal (e.g. "Pressure") resolve its real Influx field, machine, unit and
 * datasource from an existing panel on the dashboard so the ±2σ bands track the requested metric
 * instead of a hard-coded module current.
 */
function resolveSignalFromDashboard(
    panels: unknown,
    label: string
): ResolvedSignalSource | null {
    const entries = listDashboardPanels(panels);
    const lc = label.toLowerCase();
    const candidates = entries.filter(
        (e) => e.title.toLowerCase().includes(lc) && !isOwnHistoryPanel(e.title)
    );
    for (const entry of candidates) {
        const panel = entry.panel as PanelRecord;
        for (const target of getPanelTargetList(panel)) {
            const q = targetQueryText(target as PanelRecord);
            const fieldMatch = q.match(/_field\s*==\s*"([^"]+)"/);
            if (!fieldMatch?.[1]) {
                continue;
            }
            const machineMatch = q.match(/machine\s*==\s*"([^"]+)"/);
            const unit = (
                (panel.fieldConfig as { defaults?: { unit?: unknown } } | undefined)?.defaults?.unit
            );
            return {
                field: fieldMatch[1],
                machine: machineMatch?.[1],
                unit: typeof unit === 'string' ? unit : undefined,
                datasourceUid:
                    datasourceUidOf((target as PanelRecord).datasource) ??
                    datasourceUidOf(panel.datasource),
            };
        }
    }
    return null;
}

function pendingTool(name: string): ToolExecution {
    return { name, status: 'pending' };
}

function finishTool(step: ToolExecution, outcome: { ok: boolean; error?: string; summary?: string }): ToolExecution {
    return { ...step, status: outcome.ok ? 'success' : 'error', error: outcome.error, summary: outcome.summary };
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

function adaptOwnHistoryPanel(template: PanelRecord, fromModule: number, toModule: number): PanelRecord {
    const fromField = `Module${fromModule}_Current_A`;
    const toField = `Module${toModule}_Current_A`;
    let json = JSON.stringify(template);
    json = json.split(fromField).join(toField);
    json = json.split(`Module ${fromModule}`).join(`Module ${toModule}`);
    const cloned = JSON.parse(json) as PanelRecord;
    cloned.id = null;
    cloned.title = canonicalOwnHistoryTitle(toModule);
    return cloned;
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
    // `proposed` is a deep clone of the loaded dashboard, so it already carries the
    // baseline version/id/uid needed for an in-place overwrite.
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

export interface OwnHistoryPanelResult {
    ok: boolean;
    error?: string;
    toolExecutions: ToolExecution[];
    dashboardUid?: string;
    dashboardTitle?: string;
    version?: number;
    panelTitle?: string;
    panelsAdded?: string[];
    panelsRenamed?: string[];
}

export async function runProgrammaticAddOwnHistoryPanel(
    mcpClient: McpClient,
    request: AddOwnHistoryPanelRequest
): Promise<OwnHistoryPanelResult> {
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

    let title: string;
    let raw: PanelRecord;
    if (request.metricLabel) {
        title = request.panelTitle?.trim() || canonicalOwnHistoryTitleForLabel(request.metricLabel);
        const lc = request.metricLabel.toLowerCase();
        if (
            entries.some(
                (e) =>
                    e.title === title ||
                    (isOwnHistoryPanel(e.title) && e.title.toLowerCase().includes(lc))
            )
        ) {
            return { ok: false, error: `Panel "${title}" already exists.`, toolExecutions, dashboardUid: resolved.uid, dashboardTitle };
        }
        const source = resolveSignalFromDashboard(proposed.panels, request.metricLabel);
        const catalog = catalogOwnHistorySignal(request.metricLabel);
        if (!source && !catalog) {
            return {
                ok: false,
                error:
                    `Couldn't find an existing "${request.metricLabel}" Influx panel on this dashboard to base the ±2σ ` +
                    `bands on. Add or name a "${request.metricLabel}" panel first, then retry.`,
                toolExecutions,
                dashboardUid: resolved.uid,
                dashboardTitle,
            };
        }
        const influxUid =
            source?.datasourceUid ??
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
        raw = buildOwnHistoryPanelForSignal({
            machineId: source?.machine ?? machineId,
            field: source?.field ?? catalog!.field,
            title,
            signalName: catalog?.signalName ?? request.metricLabel,
            unit: source?.unit ?? catalog?.unit ?? 'none',
            influxDatasourceUid: influxUid,
        });
    } else {
        const mod = request.moduleNumber;
        if (mod == null) {
            return {
                ok: false,
                error:
                    'Which module should the own-history panel use? Name it in the prompt (e.g. Module 2 Current — vs. Own History).',
                toolExecutions,
                dashboardUid: resolved.uid,
                dashboardTitle,
                machineId,
            };
        }
        title = request.panelTitle?.trim() || canonicalOwnHistoryTitle(mod);
        if (entries.some((e) => e.title === title)) {
            return { ok: false, error: `Panel "${title}" already exists.`, toolExecutions, dashboardUid: resolved.uid, dashboardTitle };
        }
        if (
            !request.panelTitle &&
            entries.some((e) => parseModuleNumberFromTitle(e.title) === mod && isOwnHistoryPanel(e.title))
        ) {
            return {
                ok: false,
                error: `Panel "${canonicalOwnHistoryTitle(mod)}" already exists.`,
                toolExecutions,
                dashboardUid: resolved.uid,
                dashboardTitle,
            };
        }
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
        raw = buildOwnHistoryPanel(machineId, mod, influxUid, title);
    }
    const sanitized = sanitizeInfluxFluxPanel(raw) as PanelRecord;
    const repaired = repairInfluxFluxPanel(sanitized, proposed.panels as unknown[] | undefined);
    const newPanel = repaired.panel as PanelRecord;
    newPanel.id = maxPanelId(entries) + 1;

    if (!Array.isArray(proposed.panels)) {
        proposed.panels = [newPanel];
    } else {
        (proposed.panels as PanelRecord[]).push(newPanel);
    }

    const saved = await saveDashboard(mcpClient, proposed, toolExecutions);
    if (!saved.ok) {
        return { ok: false, error: saved.error, toolExecutions, dashboardUid: resolved.uid };
    }

    return {
        ok: true,
        toolExecutions,
        dashboardUid: resolved.uid,
        dashboardTitle: typeof proposed.title === 'string' ? proposed.title : resolved.title,
        version: saved.version,
        panelTitle: title,
        panelsAdded: [title],
    };
}

export async function runProgrammaticBulkOwnHistoryPanelCopy(
    mcpClient: McpClient,
    request: BulkOwnHistoryPanelCopyRequest
): Promise<OwnHistoryPanelResult> {
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
    let entries = listDashboardPanels(proposed.panels);
    const template = entries.find(
        (e) => parseModuleNumberFromTitle(e.title) === request.templateModule && isOwnHistoryPanel(e.title)
    );
    if (!template) {
        return {
            ok: false,
            error: `Template not found: ${canonicalOwnHistoryTitle(request.templateModule)}`,
            toolExecutions,
            dashboardUid: resolved.uid,
        };
    }

    const panelsAdded: string[] = [];
    let nextId = maxPanelId(entries) + 1;
    for (const moduleNum of request.targetModules) {
        entries = listDashboardPanels(proposed.panels);
        if (entries.some((e) => parseModuleNumberFromTitle(e.title) === moduleNum && isOwnHistoryPanel(e.title))) {
            continue;
        }
        const raw = adaptOwnHistoryPanel(template.panel as PanelRecord, request.templateModule, moduleNum);
        const sanitized = sanitizeInfluxFluxPanel(raw) as PanelRecord;
        const repaired = repairInfluxFluxPanel(sanitized, proposed.panels as unknown[] | undefined);
        const newPanel = repaired.panel as PanelRecord;
        newPanel.id = nextId++;
        (proposed.panels as PanelRecord[]).push(newPanel);
        panelsAdded.push(String(newPanel.title));
    }

    if (panelsAdded.length === 0) {
        return {
            ok: false,
            error: 'All target modules already have vs. Own History panels.',
            toolExecutions,
            dashboardUid: resolved.uid,
        };
    }

    // Preserve prior behavior: peer-RandomForest panels are not repositioned here.
    const positions = computeModulePanelGridPositions(listDashboardPanels(proposed.panels), false);
    for (const { entry, gridPos } of positions) {
        (entry.panel as PanelRecord).gridPos = gridPos;
        const t = entry.title;
        const normalized = normalizeLegacyModulePanelTitle(t);
        if (normalized !== t) {
            (entry.panel as PanelRecord).title = normalized;
        }
    }

    const saved = await saveDashboard(mcpClient, proposed, toolExecutions);
    if (!saved.ok) {
        return { ok: false, error: saved.error, toolExecutions, dashboardUid: resolved.uid };
    }

    return {
        ok: true,
        toolExecutions,
        dashboardUid: resolved.uid,
        dashboardTitle: typeof proposed.title === 'string' ? proposed.title : resolved.title,
        version: saved.version,
        panelsAdded,
    };
}

export async function runProgrammaticOwnHistoryCanonicalNaming(
    mcpClient: McpClient,
    dashboardUid: string
): Promise<OwnHistoryPanelResult> {
    const toolExecutions: ToolExecution[] = [];
    const loaded = await loadDashboard(mcpClient, dashboardUid, toolExecutions);
    if (!loaded.dashboard) {
        return { ok: false, error: loaded.error, toolExecutions, dashboardUid };
    }

    const proposed = JSON.parse(JSON.stringify(loaded.dashboard)) as Record<string, unknown>;
    const entries = listDashboardPanels(proposed.panels);
    const panelsRenamed: string[] = [];
    for (const entry of entries) {
        const mod = parseModuleNumberFromTitle(entry.title);
        if (mod == null || !isOwnHistoryPanel(entry.title)) {
            continue;
        }
        const canonical = canonicalOwnHistoryTitle(mod);
        if (entry.title !== canonical) {
            (entry.panel as PanelRecord).title = canonical;
            panelsRenamed.push(`${entry.title} → ${canonical}`);
        }
    }

    if (panelsRenamed.length === 0) {
        return {
            ok: true,
            toolExecutions,
            dashboardUid,
            dashboardTitle: typeof proposed.title === 'string' ? proposed.title : undefined,
            panelsRenamed: ['All own-history panels already use canonical titles.'],
        };
    }

    const saved = await saveDashboard(mcpClient, proposed, toolExecutions);
    if (!saved.ok) {
        return { ok: false, error: saved.error, toolExecutions, dashboardUid };
    }

    return {
        ok: true,
        toolExecutions,
        dashboardUid,
        version: saved.version,
        panelsRenamed,
    };
}

export function formatAddOwnHistoryPanelReply(result: OwnHistoryPanelResult, build: number): string {
    if (!result.ok) {
        return `### Own History panel — failed (build ${build})\n\n${result.error ?? 'Unknown error'}`;
    }
    return (
        `### Own History panel — saved (build ${build})\n\n` +
        `- Dashboard: \`${result.dashboardUid}\` v${result.version ?? '?'}\n` +
        `- Panel: **${result.panelTitle ?? result.panelsAdded?.[0] ?? '?'}**\n` +
        `- Series: Actual, Historical Mean, Upper/Lower Bound (±2σ) — **computed in Flux** (mean ± 2×stddev), not legend-only`
    );
}

export function formatBulkOwnHistoryPanelReply(result: OwnHistoryPanelResult, build: number): string {
    if (!result.ok) {
        return `### Copy Own History panels — failed (build ${build})\n\n${result.error ?? 'Unknown error'}`;
    }
    return (
        `### Copy Own History panels — saved (build ${build})\n\n` +
        `- Dashboard: \`${result.dashboardUid}\` v${result.version ?? '?'}\n` +
        `- Added: ${(result.panelsAdded ?? []).map((t) => `**${t}**`).join(', ') || 'none'}\n` +
        `- Reordered Module N Current blocks (own-history before peer band)`
    );
}

export function formatOwnHistoryNamingReply(result: OwnHistoryPanelResult, build: number): string {
    if (!result.ok) {
        return `### Own History naming — failed (build ${build})\n\n${result.error ?? 'Unknown error'}`;
    }
    return (
        `### Own History naming — OK (build ${build})\n\n` +
        `- Dashboard: \`${result.dashboardUid}\` v${result.version ?? '?'}\n` +
        `- ${(result.panelsRenamed ?? []).join('\n- ')}`
    );
}
