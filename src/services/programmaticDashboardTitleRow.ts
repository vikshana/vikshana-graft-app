import type { ToolExecution } from '../types/llm.types';
import { extractDashboardFromGetByUid } from './programmaticDashboardClone';
import { callMcpTool } from './mcpToolClient';
import type { McpClient } from './dashboardChunkedUpdate';
import { stampDashboardForOverwrite } from './fluxQueryFix';
import { normalizeUpdateDashboardArgs } from './updateDashboardArgs';
import { parseSearchHitsFromMcpText } from './dashboardSearchParse';
import type { DashboardTitleRowRequest } from './dashboardTitleRowParse';
import { formatDashboardTitleRowExamplePrompt } from './dashboardTitleRowParse';
import {
    applyDashboardTitleRow,
    isDashboardTitleRowLayoutApplied,
    panelLooksLikeDashboardTitleRow,
} from './dashboardTitleRowLayout';

type PanelRecord = Record<string, unknown>;

export interface DashboardTitleRowResult {
    ok: boolean;
    error?: string;
    toolExecutions: ToolExecution[];
    dashboardUid?: string;
    dashboardTitle?: string;
    version?: number;
    titleLabel?: string;
    panelId?: number;
    created?: boolean;
    shiftedPanels?: number;
}

function pendingTool(name: string): ToolExecution {
    return { name, status: 'pending' };
}

function finishTool(step: ToolExecution, outcome: { ok: boolean; error?: string; summary?: string }): ToolExecution {
    return { ...step, status: outcome.ok ? 'success' : 'error', error: outcome.error, summary: outcome.summary };
}

async function resolveDashboard(
    mcpClient: McpClient,
    request: DashboardTitleRowRequest,
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

export async function runProgrammaticDashboardTitleRow(
    mcpClient: McpClient,
    request: DashboardTitleRowRequest
): Promise<DashboardTitleRowResult> {
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
    const originalPanels = Array.isArray(baseline.panels) ? (baseline.panels as PanelRecord[]) : [];
    const originalTitlePanel =
        originalPanels.find((p) => panelLooksLikeDashboardTitleRow(p)) ??
        originalPanels.find((p) => p.type === 'text' && panelLooksLikeDashboardTitleRow(p));
    const originalLayoutOk =
        originalTitlePanel != null &&
        isDashboardTitleRowLayoutApplied(
            [originalTitlePanel, ...originalPanels.filter((p) => p !== originalTitlePanel)],
            originalTitlePanel
        );
    const originalLabelMatches =
        originalTitlePanel != null &&
        panelLooksLikeDashboardTitleRow(originalTitlePanel, request.titleLabel);

    if (originalLayoutOk && originalLabelMatches) {
        return {
            ok: true,
            toolExecutions,
            dashboardUid: resolved.uid,
            dashboardTitle,
            titleLabel: request.titleLabel,
            panelId: typeof originalTitlePanel.id === 'number' ? originalTitlePanel.id : undefined,
            created: false,
            shiftedPanels: 0,
        };
    }

    const proposed = JSON.parse(JSON.stringify(baseline)) as Record<string, unknown>;
    const topLevel = Array.isArray(proposed.panels) ? (proposed.panels as PanelRecord[]) : [];

    const applied = applyDashboardTitleRow(topLevel, request.titleLabel);
    proposed.panels = applied.panels;

    const saveStep = pendingTool('update_dashboard');
    toolExecutions.push(saveStep);
    const savePayload = normalizeUpdateDashboardArgs({
        dashboard: stampDashboardForOverwrite(baseline, proposed),
        overwrite: true,
    });
    const save = await callMcpTool(mcpClient, 'update_dashboard', savePayload);
    toolExecutions[toolExecutions.length - 1] = finishTool(saveStep, save);
    if (!save.ok) {
        return { ok: false, error: save.error ?? 'update_dashboard failed', toolExecutions, dashboardUid: resolved.uid };
    }

    const versionMatch = save.text.match(/"version"\s*:\s*(\d+)/);
    const version = versionMatch ? parseInt(versionMatch[1], 10) : undefined;

    return {
        ok: true,
        toolExecutions,
        dashboardUid: resolved.uid,
        dashboardTitle,
        version,
        titleLabel: request.titleLabel,
        panelId: typeof applied.titlePanel.id === 'number' ? applied.titlePanel.id : undefined,
        created: applied.created,
        shiftedPanels: applied.shiftedPanels,
    };
}

export function formatDashboardTitleRowReply(result: DashboardTitleRowResult, buildNumber: string | number): string {
    if (!result.ok) {
        return (
            `### Dashboard title row — failed (build ${buildNumber})\n\n` +
            `${result.error ?? 'Unknown error'}\n\n` +
            `Example:\n\n\`\`\`text\n${formatDashboardTitleRowExamplePrompt()}\n\`\`\``
        );
    }
    if (result.shiftedPanels === 0 && !result.created && result.version == null) {
        return (
            `### Dashboard title row — already correct (build ${buildNumber})\n\n` +
            `- Dashboard: \`${result.dashboardUid}\` · **${result.titleLabel}**\n` +
            `- Title panel id **${result.panelId ?? '?'}** is first in the panel list at y=0`
        );
    }
    return (
        `### Dashboard title row — saved (build ${buildNumber})\n\n` +
        `- Dashboard: \`${result.dashboardUid}\` · version **${result.version ?? '?'}**\n` +
        `- Title: **${result.titleLabel}** · panel id **${result.panelId ?? '?'}**\n` +
        `- ${result.created ? 'Created' : 'Updated'} full-width text row (w=24, h=2) at **y=0**, index **0**\n` +
        `- Shifted **${result.shiftedPanels ?? 0}** other panel(s) down by 2 grid units\n\n` +
        `Hard-refresh the dashboard (**Cmd+Shift+R**). The title should appear above Pressure/Temperature rows.`
    );
}
