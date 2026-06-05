import type { ToolExecution } from '../types/llm.types';
import { extractDashboardFromGetByUid } from './programmaticDashboardClone';
import { callMcpTool } from './mcpToolClient';
import type { McpClient } from './dashboardChunkedUpdate';
import { stampDashboardForOverwrite } from './fluxQueryFix';
import { normalizeUpdateDashboardArgs } from './updateDashboardArgs';
import { listDashboardPanels, type DashboardPanelEntry } from './panelDiscovery';
import { parseSearchHitsFromMcpText } from './dashboardSearchParse';
import type { ModulePanelReorderRequest } from './modulePanelReorderParse';
import {
    formatModulePanelReorderExamplePrompt,
    MODULE_CURRENT_TITLE_RE,
    parseModuleNumberFromTitle,
} from './modulePanelReorderParse';
import {
    isPeerRandomForestPanel,
    modulePanelSortKey,
    normalizeLegacyModulePanelTitle,
} from './modulePanelTitles';

type PanelRecord = Record<string, unknown>;

export const MODULE_PANEL_GRID = { w: 24, h: 12 } as const;

export interface ProgrammaticModulePanelReorderResult {
    ok: boolean;
    error?: string;
    toolExecutions: ToolExecution[];
    dashboardUid?: string;
    dashboardTitle?: string;
    version?: number;
    panelsMoved: number;
    moduleOrder: number[];
    panelTitles: string[];
}

function pendingTool(name: string): ToolExecution {
    return { name, status: 'pending' };
}

function finishTool(step: ToolExecution, outcome: { ok: boolean; error?: string; summary?: string }): ToolExecution {
    return {
        ...step,
        status: outcome.ok ? 'success' : 'error',
        error: outcome.error,
        summary: outcome.summary,
    };
}

export function selectModuleCurrentPanels(
    entries: DashboardPanelEntry[],
    includeRandomForest: boolean
): DashboardPanelEntry[] {
    return entries.filter((e) => {
        if (!MODULE_CURRENT_TITLE_RE.test(e.title)) {
            return false;
        }
        if (!includeRandomForest && isPeerRandomForestPanel(e.title)) {
            return false;
        }
        return parseModuleNumberFromTitle(e.title) != null;
    });
}

export function computeModulePanelGridPositions(
    entries: DashboardPanelEntry[],
    includeRandomForest: boolean,
    startY?: number
): { entry: DashboardPanelEntry; gridPos: { x: number; y: number; w: number; h: number } }[] {
    const matched = selectModuleCurrentPanels(entries, includeRandomForest);
    if (matched.length === 0) {
        return [];
    }

    let y =
        startY ??
        Math.min(
            ...matched.map((e) => {
                const gp = e.panel.gridPos as { y?: number } | undefined;
                return typeof gp?.y === 'number' ? gp.y : 0;
            })
        );

    const byModule = new Map<number, DashboardPanelEntry[]>();
    for (const e of matched) {
        const n = parseModuleNumberFromTitle(e.title);
        if (n == null) {
            continue;
        }
        const list = byModule.get(n) ?? [];
        list.push(e);
        byModule.set(n, list);
    }

    const moduleOrder = [...byModule.keys()].sort((a, b) => a - b);
    const out: { entry: DashboardPanelEntry; gridPos: { x: number; y: number; w: number; h: number } }[] = [];

    for (const moduleNum of moduleOrder) {
        const group = (byModule.get(moduleNum) ?? []).sort(
            (a, b) => modulePanelSortKey(a.title) - modulePanelSortKey(b.title)
        );
        for (const entry of group) {
            out.push({
                entry,
                gridPos: {
                    x: 0,
                    y,
                    w: MODULE_PANEL_GRID.w,
                    h: MODULE_PANEL_GRID.h,
                },
            });
            y += MODULE_PANEL_GRID.h;
        }
    }

    return out;
}

async function resolveDashboard(
    mcpClient: McpClient,
    request: ModulePanelReorderRequest,
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

export async function runProgrammaticModulePanelReorder(
    mcpClient: McpClient,
    request: ModulePanelReorderRequest
): Promise<ProgrammaticModulePanelReorderResult> {
    const toolExecutions: ToolExecution[] = [];
    const resolved = await resolveDashboard(mcpClient, request, toolExecutions);
    if (!resolved.uid) {
        return { ok: false, error: resolved.error, toolExecutions, panelsMoved: 0, moduleOrder: [], panelTitles: [] };
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
            panelsMoved: 0,
            moduleOrder: [],
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
            panelsMoved: 0,
            moduleOrder: [],
            panelTitles: [],
        };
    }

    const baseline = extracted.dashboard;
    const dashboardTitle = typeof baseline.title === 'string' ? baseline.title : resolved.title;
    const proposed = JSON.parse(JSON.stringify(baseline)) as Record<string, unknown>;
    const entries = listDashboardPanels(proposed.panels);
    const placements = computeModulePanelGridPositions(entries, request.includeRandomForest);

    if (placements.length === 0) {
        return {
            ok: false,
            error: 'No panels matching "Module N Current" found on this dashboard.',
            toolExecutions,
            dashboardUid: resolved.uid,
            dashboardTitle,
            panelsMoved: 0,
            moduleOrder: [],
            panelTitles: [],
        };
    }

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
            panelsMoved: 0,
            moduleOrder: [],
            panelTitles: [],
        };
    }

    const versionMatch = save.text.match(/"version"\s*:\s*(\d+)/);
    const version = versionMatch ? parseInt(versionMatch[1], 10) : undefined;
    const moduleOrder = [
        ...new Set(
            placements
                .map((p) => parseModuleNumberFromTitle(p.entry.title))
                .filter((n): n is number => n != null)
        ),
    ].sort((a, b) => a - b);

    return {
        ok: true,
        toolExecutions,
        dashboardUid: resolved.uid,
        dashboardTitle,
        version,
        panelsMoved: placements.length,
        moduleOrder,
        panelTitles: placements.map((p) => p.entry.title),
    };
}

export function formatModulePanelReorderReply(
    result: ProgrammaticModulePanelReorderResult,
    buildNumber: string | number
): string {
    if (!result.ok) {
        return (
            `### Could not reorder Module panels (build ${buildNumber})\n\n` +
            `${result.error ?? 'Unknown error'}\n\n` +
            `Example prompt:\n\n\`\`\`text\n${formatModulePanelReorderExamplePrompt()}\n\`\`\``
        );
    }
    const lines = [
        `### Done (Module panels reordered) build ${buildNumber}`,
        '',
        `**Dashboard:** ${result.dashboardTitle ?? result.dashboardUid ?? '?'}` +
            (result.version != null ? ` · version **${result.version}**` : ''),
        `**Panels moved:** ${result.panelsMoved} · **Modules:** ${result.moduleOrder.join(' → ')}`,
        `**Size:** ${MODULE_PANEL_GRID.w}×${MODULE_PANEL_GRID.h} grid units (full width)`,
        '',
        'Hard-refresh the dashboard (**Cmd+Shift+R**). Scroll to the Module 1–8 section.',
    ];
    if (result.panelTitles.length > 0 && result.panelTitles.length <= 20) {
        lines.push('', '**Order:**');
        for (const t of result.panelTitles) {
            lines.push(`- ${t}`);
        }
    }
    return lines.join('\n');
}
