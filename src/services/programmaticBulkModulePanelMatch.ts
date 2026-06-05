import type { ToolExecution } from '../types/llm.types';
import { extractDashboardFromGetByUid } from './programmaticDashboardClone';
import { callMcpTool } from './mcpToolClient';
import type { McpClient } from './dashboardChunkedUpdate';
import { stampDashboardForOverwrite } from './fluxQueryFix';
import { normalizeUpdateDashboardArgs } from './updateDashboardArgs';
import { listDashboardPanels, type DashboardPanelEntry } from './panelDiscovery';
import { parseSearchHitsFromMcpText } from './dashboardSearchParse';
import type { BulkModulePanelMatchRequest } from './bulkModulePanelMatchParse';
import { formatBulkModulePanelMatchExamplePrompt } from './bulkModulePanelMatchParse';
import { parseModuleNumberFromTitle } from './modulePanelReorderParse';
import {
    canonicalHistoricalHistoryComparisonTitle,
    isHistoricalHistoryComparisonPanel,
    isPeerRandomForestPanel,
    normalizeLegacyModulePanelTitle,
} from './modulePanelTitles';
import {
    computeModulePanelGridPositions,
    MODULE_PANEL_GRID,
} from './programmaticModulePanelReorder';
import { repairInfluxFluxPanel, sanitizeInfluxFluxPanel } from './sanitizeInfluxFluxPanel';

type PanelRecord = Record<string, unknown>;

export interface ProgrammaticBulkModulePanelMatchResult {
    ok: boolean;
    error?: string;
    toolExecutions: ToolExecution[];
    dashboardUid?: string;
    dashboardTitle?: string;
    version?: number;
    panelsAdded: string[];
    panelsSkipped: string[];
    panelTitles: string[];
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

function findModulePanel(
    entries: DashboardPanelEntry[],
    moduleNum: number,
    predicate: (title: string) => boolean
): DashboardPanelEntry | undefined {
    return entries.find((e) => parseModuleNumberFromTitle(e.title) === moduleNum && predicate(e.title));
}

function peerRfTitle(moduleNum: number): string {
    return `Module ${moduleNum} Current — RandomForest vs Peers (Influx)`;
}

function adaptPanelFromTemplate(
    template: PanelRecord,
    fromModule: number,
    toModule: number,
    kind: 'historical' | 'peer_rf'
): PanelRecord {
    const fromField = `Module${fromModule}_Current_A`;
    const toField = `Module${toModule}_Current_A`;
    let json = JSON.stringify(template);
    json = json.split(fromField).join(toField);
    json = json.split(`Module ${fromModule}`).join(`Module ${toModule}`);
    const cloned = JSON.parse(json) as PanelRecord;
    cloned.id = null;
    cloned.title =
        kind === 'historical'
            ? canonicalHistoricalHistoryComparisonTitle(toModule)
            : peerRfTitle(toModule);
    return cloned;
}

async function resolveDashboard(
    mcpClient: McpClient,
    request: BulkModulePanelMatchRequest,
    toolExecutions: ToolExecution[]
): Promise<{ uid?: string; title?: string; error?: string }> {
    if (request.dashboardUid) {
        return { uid: request.dashboardUid };
    }
    const searchTitle = request.dashboardTitle;
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
        hits.find((h) => {
            const machine = searchTitle.match(/^([0-9]{4}-[0-9]+)/)?.[1];
            return machine && h.title?.includes(machine);
        }) ??
        hits[0];
    if (!match?.uid) {
        return { error: `No dashboard found for "${searchTitle}".` };
    }
    return { uid: match.uid, title: match.title };
}

export async function runProgrammaticBulkModulePanelMatch(
    mcpClient: McpClient,
    request: BulkModulePanelMatchRequest
): Promise<ProgrammaticBulkModulePanelMatchResult> {
    const toolExecutions: ToolExecution[] = [];
    const resolved = await resolveDashboard(mcpClient, request, toolExecutions);
    if (!resolved.uid) {
        return {
            ok: false,
            error: resolved.error,
            toolExecutions,
            panelsAdded: [],
            panelsSkipped: [],
            panelTitles: [],
        };
    }

    const getStep = pendingTool('get_dashboard_by_uid');
    toolExecutions.push(getStep);
    const fetch = await callMcpTool(mcpClient, 'get_dashboard_by_uid', { uid: resolved.uid });
    toolExecutions[toolExecutions.length - 1] = finishTool(getStep, fetch);
    if (!fetch.ok) {
        return {
            ok: false,
            error: fetch.error ?? 'Could not load dashboard',
            toolExecutions,
            dashboardUid: resolved.uid,
            panelsAdded: [],
            panelsSkipped: [],
            panelTitles: [],
        };
    }

    const extracted = extractDashboardFromGetByUid(fetch.text);
    if (!extracted?.dashboard) {
        return {
            ok: false,
            error: 'Could not parse dashboard JSON',
            toolExecutions,
            dashboardUid: resolved.uid,
            panelsAdded: [],
            panelsSkipped: [],
            panelTitles: [],
        };
    }

    const baseline = extracted.dashboard;
    const dashboardTitle = typeof baseline.title === 'string' ? baseline.title : resolved.title;
    const proposed = JSON.parse(JSON.stringify(baseline)) as Record<string, unknown>;
    let entries = listDashboardPanels(proposed.panels);

    const templateModule = request.templateModule;
    const historicalTemplate = findModulePanel(entries, templateModule, isHistoricalHistoryComparisonPanel);
    const peerRfTemplate = findModulePanel(entries, templateModule, isPeerRandomForestPanel);

    if (!historicalTemplate) {
        return {
            ok: false,
            error: `Template panel not found: Module ${templateModule} historical History Comparison (Influx).`,
            toolExecutions,
            dashboardUid: resolved.uid,
            dashboardTitle,
            panelsAdded: [],
            panelsSkipped: [],
            panelTitles: [],
        };
    }
    if (!peerRfTemplate) {
        return {
            ok: false,
            error: `Template panel not found: Module ${templateModule} RandomForest vs Peers (Influx).`,
            toolExecutions,
            dashboardUid: resolved.uid,
            dashboardTitle,
            panelsAdded: [],
            panelsSkipped: [],
            panelTitles: [],
        };
    }

    const panelsAdded: string[] = [];
    const panelsSkipped: string[] = [];
    let nextId = maxPanelId(entries) + 1;

    for (const moduleNum of request.targetModules) {
        entries = listDashboardPanels(proposed.panels);
        if (!entries.some((e) => parseModuleNumberFromTitle(e.title) === moduleNum && isHistoricalHistoryComparisonPanel(e.title))) {
            const raw = adaptPanelFromTemplate(
                historicalTemplate.panel as PanelRecord,
                templateModule,
                moduleNum,
                'historical'
            );
            const sanitized = sanitizeInfluxFluxPanel(raw) as PanelRecord;
            const repaired = repairInfluxFluxPanel(sanitized, proposed.panels);
            const newPanel = repaired.panel as PanelRecord;
            newPanel.id = nextId++;
            if (!Array.isArray(proposed.panels)) {
                proposed.panels = [newPanel];
            } else {
                (proposed.panels as PanelRecord[]).push(newPanel);
            }
            panelsAdded.push(String(newPanel.title));
        } else {
            panelsSkipped.push(`Module ${moduleNum} historical History Comparison (already exists)`);
        }

        if (!entries.some((e) => parseModuleNumberFromTitle(e.title) === moduleNum && isPeerRandomForestPanel(e.title))) {
            const raw = adaptPanelFromTemplate(
                peerRfTemplate.panel as PanelRecord,
                templateModule,
                moduleNum,
                'peer_rf'
            );
            const sanitized = sanitizeInfluxFluxPanel(raw) as PanelRecord;
            const repaired = repairInfluxFluxPanel(sanitized, proposed.panels);
            const newPanel = repaired.panel as PanelRecord;
            newPanel.id = nextId++;
            if (!Array.isArray(proposed.panels)) {
                proposed.panels = [newPanel];
            } else {
                (proposed.panels as PanelRecord[]).push(newPanel);
            }
            panelsAdded.push(String(newPanel.title));
        } else {
            panelsSkipped.push(`Module ${moduleNum} RandomForest vs Peers (already exists)`);
        }
    }

    entries = listDashboardPanels(proposed.panels);
    const placements = computeModulePanelGridPositions(entries, true);
    for (const { entry, gridPos } of placements) {
        const panel = entry.panel as PanelRecord;
        panel.gridPos = gridPos;
        const normalizedTitle = normalizeLegacyModulePanelTitle(entry.title);
        if (normalizedTitle !== entry.title) {
            panel.title = normalizedTitle;
            entry.title = normalizedTitle;
        }
    }

    const saveStep = pendingTool('update_dashboard');
    toolExecutions.push(saveStep);
    const savePayload = normalizeUpdateDashboardArgs({
        dashboard: stampDashboardForOverwrite(baseline, proposed),
        overwrite: true,
    });
    const save = await callMcpTool(mcpClient, 'update_dashboard', savePayload);
    toolExecutions[toolExecutions.length - 1] = finishTool(saveStep, save);

    if (!save.ok) {
        return {
            ok: false,
            error: save.error ?? 'update_dashboard failed',
            toolExecutions,
            dashboardUid: resolved.uid,
            dashboardTitle,
            panelsAdded,
            panelsSkipped,
            panelTitles: [],
        };
    }

    const versionMatch = save.text.match(/"version"\s*:\s*(\d+)/);
    const version = versionMatch ? parseInt(versionMatch[1], 10) : undefined;

    return {
        ok: true,
        toolExecutions,
        dashboardUid: resolved.uid,
        dashboardTitle,
        version,
        panelsAdded,
        panelsSkipped,
        panelTitles: placements.map((p) => p.entry.title),
    };
}

export function formatBulkModulePanelMatchReply(
    result: ProgrammaticBulkModulePanelMatchResult,
    buildNumber: string | number
): string {
    if (!result.ok) {
        return (
            `### Could not match Module panels (build ${buildNumber})\n\n` +
            `${result.error ?? 'Unknown error'}\n\n` +
            `Example:\n\n\`\`\`text\n${formatBulkModulePanelMatchExamplePrompt()}\n\`\`\``
        );
    }
    const lines = [
        `### Done (Module panels matched to Module 5) build ${buildNumber}`,
        '',
        `**Dashboard:** ${result.dashboardTitle ?? result.dashboardUid ?? '?'}` +
            (result.version != null ? ` · version **${result.version}**` : ''),
        `**Panels added:** ${result.panelsAdded.length}`,
        `**Layout:** Modules 1→8 · per module: History Comparison → historical/Influx → Peer Band → RandomForest vs Peers · ${MODULE_PANEL_GRID.w}×${MODULE_PANEL_GRID.h}`,
        '',
        'Hard-refresh the dashboard (**Cmd+Shift+R**).',
    ];
    if (result.panelsAdded.length > 0) {
        lines.push('', '**Added:**');
        for (const t of result.panelsAdded) {
            lines.push(`- ${t}`);
        }
    }
    if (result.panelsSkipped.length > 0) {
        lines.push('', '**Skipped (already present):**');
        for (const t of result.panelsSkipped) {
            lines.push(`- ${t}`);
        }
    }
    if (result.panelTitles.length > 0 && result.panelTitles.length <= 40) {
        lines.push('', '**Final order:**');
        for (const t of result.panelTitles) {
            lines.push(`- ${t}`);
        }
    }
    return lines.join('\n');
}
