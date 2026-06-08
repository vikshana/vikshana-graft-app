import type { ToolExecution } from '../types/llm.types';
import { extractDashboardFromGetByUid } from './programmaticDashboardClone';
import { callMcpTool } from './mcpToolClient';
import type { McpClient } from './dashboardChunkedUpdate';
import { stampDashboardForOverwrite } from './fluxQueryFix';
import { normalizeUpdateDashboardArgs } from './updateDashboardArgs';
import { parseSearchHitsFromMcpText } from './dashboardSearchParse';
import type { DashboardRebuildRequest } from './dashboardRebuildParse';
import { formatDashboardRebuildExamplePrompt } from './dashboardRebuildParse';
import { applyBestPracticeDashboardLayout } from './dashboardLayoutBestPractices';

type PanelRecord = Record<string, unknown>;

export interface DashboardRebuildResult {
    ok: boolean;
    error?: string;
    toolExecutions: ToolExecution[];
    dashboardUid?: string;
    dashboardTitle?: string;
    version?: number;
    repositionedPanels?: number;
    isModuleDashboard?: boolean;
}

function pendingTool(name: string): ToolExecution {
    return { name, status: 'pending' };
}

function finishTool(step: ToolExecution, outcome: { ok: boolean; error?: string; summary?: string }): ToolExecution {
    return { ...step, status: outcome.ok ? 'success' : 'error', error: outcome.error, summary: outcome.summary };
}

async function resolveDashboard(
    mcpClient: McpClient,
    request: DashboardRebuildRequest,
    toolExecutions: ToolExecution[]
): Promise<{ uid?: string; title?: string; error?: string }> {
    if (request.dashboardUid) {
        return { uid: request.dashboardUid };
    }
    const searchTitle = request.dashboardTitle;
    const searchQuery =
        searchTitle ??
        (request.titleLabel ? `${request.titleLabel}` : undefined);
    if (!searchQuery) {
        return { error: 'Need dashboard uid or title.' };
    }
    const searchStep = pendingTool('search_dashboards');
    toolExecutions.push(searchStep);
    const searchResult = await callMcpTool(mcpClient, 'search_dashboards', { query: searchQuery });
    toolExecutions[toolExecutions.length - 1] = finishTool(searchStep, searchResult);
    if (!searchResult.ok) {
        return { error: searchResult.error ?? 'Dashboard search failed' };
    }
    const hits = parseSearchHitsFromMcpText(searchResult.text);
    const match =
        hits.find((h) => searchTitle && h.title?.includes(searchTitle)) ??
        hits.find((h) => request.titleLabel && h.title?.toLowerCase().includes(request.titleLabel.toLowerCase())) ??
        hits[0];
    if (!match?.uid) {
        return { error: `No dashboard found for "${searchQuery}".` };
    }
    return { uid: match.uid, title: match.title };
}

export async function runProgrammaticDashboardRebuild(
    mcpClient: McpClient,
    request: DashboardRebuildRequest
): Promise<DashboardRebuildResult> {
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
    const topLevel = Array.isArray(proposed.panels) ? (proposed.panels as PanelRecord[]) : [];

    const applied = applyBestPracticeDashboardLayout(topLevel, {
        dashboardTitle,
        titleLabel: request.titleLabel,
    });
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
        repositionedPanels: applied.repositionedPanels,
        isModuleDashboard: applied.isModuleDashboard,
    };
}

export function formatDashboardRebuildReply(result: DashboardRebuildResult, buildNumber: string | number): string {
    if (!result.ok) {
        return (
            `### Dashboard rebuild — failed (build ${buildNumber})\n\n` +
            `${result.error ?? 'Unknown error'}\n\n` +
            `Example:\n\n\`\`\`text\n${formatDashboardRebuildExamplePrompt()}\n\`\`\``
        );
    }
    const kind = result.isModuleDashboard
        ? 'Module dashboard: instrumentation on top, Module N Current block at bottom'
        : 'Instrumentation dashboard: title row → KPIs → trends → overview (Keysight-style)';
    return (
        `### Dashboard rebuild — saved (build ${buildNumber})\n\n` +
        `- Dashboard: \`${result.dashboardUid}\` · version **${result.version ?? '?'}**\n` +
        `- Layout: ${kind}\n` +
        `- Repositioned **${result.repositionedPanels ?? 0}** panel grid slot(s); panel queries unchanged\n\n` +
        `Hard-refresh the dashboard (**Cmd+Shift+R**).`
    );
}
