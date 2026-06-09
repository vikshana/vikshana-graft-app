import type { ToolExecution } from '../types/llm.types';
import { extractDashboardFromGetByUid } from './programmaticDashboardClone';
import { callMcpTool } from './mcpToolClient';
import type { McpClient } from './dashboardChunkedUpdate';
import { stampDashboardForOverwrite } from './fluxQueryFix';
import { normalizeUpdateDashboardArgs } from './updateDashboardArgs';
import {
    findPanelForRemoval,
    listDashboardPanels,
    normalizePanelTitleForMatch,
    removePanelAtPath,
} from './panelDiscovery';
import type { PanelRemoveRequest } from './panelRemoveParse';
import { formatPanelRemoveNotFoundClarification } from './panelRemoveParse';
import { parseSearchHitsFromMcpText } from './dashboardSearchParse';

export interface ProgrammaticPanelRemoveResult {
    ok: boolean;
    error?: string;
    clarification?: boolean;
    toolExecutions: ToolExecution[];
    dashboardUid?: string;
    dashboardTitle?: string;
    removedPanelTitle?: string;
    panelId?: number;
    version?: number;
}

function pendingTool(name: string): ToolExecution {
    return { name, status: 'pending' };
}

function finishTool(step: ToolExecution, outcome: { ok: boolean; error?: string; summary?: string }): ToolExecution {
    return { ...step, status: outcome.ok ? 'success' : 'error', error: outcome.error, summary: outcome.summary };
}

async function resolveDashboardUid(
    mcpClient: McpClient,
    request: PanelRemoveRequest,
    toolExecutions: ToolExecution[],
    contextDashboardUid?: string
): Promise<{ uid?: string; title?: string; error?: string; clarification?: string }> {
    if (request.dashboardUid) {
        return { uid: request.dashboardUid };
    }

    if (!request.machineId) {
        return { uid: contextDashboardUid };
    }

    const searchStep = pendingTool('search_dashboards');
    toolExecutions.push(searchStep);
    const search = await callMcpTool(mcpClient, 'search_dashboards', { query: request.machineId });
    toolExecutions[toolExecutions.length - 1] = finishTool(searchStep, search);
    if (!search.ok) {
        return { error: search.error ?? 'search_dashboards failed' };
    }

    const hits = parseSearchHitsFromMcpText(search.text);
    const matching = hits.filter((h) => h.title.includes(request.machineId!));
    if (matching.length === 1) {
        return { uid: matching[0].uid, title: matching[0].title };
    }
    if (matching.length > 1) {
        const list = matching
            .slice(0, 8)
            .map((m) => `- **${m.title}** — uid \`${m.uid}\``)
            .join('\n');
        return {
            clarification:
                `### Need clarification\n\n` +
                `Multiple dashboards match machine **${request.machineId}**:\n\n${list}\n\n` +
                `Reply with the dashboard **uid**.`,
        };
    }
    if (hits.length === 1) {
        return { uid: hits[0].uid, title: hits[0].title };
    }
    return { uid: contextDashboardUid };
}

function panelStillPresent(
    entries: ReturnType<typeof listDashboardPanels>,
    removedTitle: string,
    panelId?: number
): boolean {
    if (panelId != null) {
        return entries.some((e) => e.panelId === panelId);
    }
    const key = normalizePanelTitleForMatch(removedTitle);
    return entries.some((e) => normalizePanelTitleForMatch(e.title) === key);
}

export async function runProgrammaticPanelRemove(
    mcpClient: McpClient,
    request: PanelRemoveRequest,
    opts?: { contextDashboardUid?: string }
): Promise<ProgrammaticPanelRemoveResult> {
    const toolExecutions: ToolExecution[] = [];

    const resolved = await resolveDashboardUid(mcpClient, request, toolExecutions, opts?.contextDashboardUid);
    if (resolved.clarification) {
        return { ok: false, clarification: true, error: resolved.clarification, toolExecutions };
    }
    if (resolved.error) {
        return { ok: false, error: resolved.error, toolExecutions };
    }
    if (!resolved.uid) {
        return {
            ok: false,
            clarification: true,
            error: formatPanelRemoveNotFoundClarification(request),
            toolExecutions,
        };
    }

    const targetUid = resolved.uid;
    const getStep = pendingTool('get_dashboard_by_uid');
    toolExecutions.push(getStep);
    const getResult = await callMcpTool(mcpClient, 'get_dashboard_by_uid', { uid: targetUid });
    toolExecutions[toolExecutions.length - 1] = finishTool(getStep, getResult);
    if (!getResult.ok) {
        return {
            ok: false,
            clarification: true,
            error: formatPanelRemoveNotFoundClarification(request),
            toolExecutions,
            dashboardUid: targetUid,
        };
    }

    const extracted = extractDashboardFromGetByUid(getResult.text);
    if (!extracted?.dashboard) {
        return { ok: false, error: 'Could not parse dashboard JSON', toolExecutions, dashboardUid: targetUid };
    }

    const baseline = extracted.dashboard;
    const dashboardTitle = typeof baseline.title === 'string' ? baseline.title : resolved.title;
    const entries = listDashboardPanels(baseline.panels);
    const panelEntry = findPanelForRemoval(entries, request.panelTitle);
    if (!panelEntry) {
        return {
            ok: false,
            clarification: true,
            error: formatPanelRemoveNotFoundClarification(request, {
                dashboardTitle,
                panelTitles: entries.map((e) => e.title).filter(Boolean),
            }),
            toolExecutions,
            dashboardUid: targetUid,
            dashboardTitle,
        };
    }

    const removedPanelTitle = panelEntry.title;
    const panelId = typeof panelEntry.panel.id === 'number' ? panelEntry.panel.id : undefined;

    const proposed = JSON.parse(JSON.stringify(baseline)) as Record<string, unknown>;
    const topPanels = proposed.panels;
    if (!Array.isArray(topPanels)) {
        return { ok: false, error: 'Dashboard has no panels array', toolExecutions, dashboardUid: targetUid };
    }

    if (!removePanelAtPath(topPanels, panelEntry.path)) {
        return { ok: false, error: 'Could not remove panel from dashboard tree', toolExecutions, dashboardUid: targetUid };
    }

    const saveStep = pendingTool('update_dashboard');
    toolExecutions.push(saveStep);
    const savePayload = normalizeUpdateDashboardArgs({
        dashboard: stampDashboardForOverwrite(baseline, proposed),
        overwrite: true,
        message: `Graft: remove panel "${removedPanelTitle}"`,
    });
    const saveResult = await callMcpTool(mcpClient, 'update_dashboard', savePayload);
    toolExecutions[toolExecutions.length - 1] = finishTool(saveStep, saveResult);
    if (!saveResult.ok) {
        return {
            ok: false,
            error: saveResult.error ?? 'update_dashboard failed',
            toolExecutions,
            dashboardUid: targetUid,
            dashboardTitle,
            removedPanelTitle,
            panelId,
        };
    }

    const verifyStep = pendingTool('get_dashboard_by_uid');
    toolExecutions.push(verifyStep);
    const verify = await callMcpTool(mcpClient, 'get_dashboard_by_uid', { uid: targetUid });
    toolExecutions[toolExecutions.length - 1] = finishTool(verifyStep, verify);

    let version: number | undefined;
    if (verify.ok) {
        const verified = extractDashboardFromGetByUid(verify.text);
        version = typeof verified?.dashboard?.version === 'number' ? verified.dashboard.version : undefined;
        const verifiedEntries = listDashboardPanels(verified?.dashboard?.panels);
        if (panelStillPresent(verifiedEntries, removedPanelTitle, panelId)) {
            return {
                ok: false,
                error: `Save reported success but panel **${removedPanelTitle}** is still on the dashboard.`,
                toolExecutions,
                dashboardUid: targetUid,
                dashboardTitle,
                removedPanelTitle,
                panelId,
                version,
            };
        }
    }

    return {
        ok: true,
        toolExecutions,
        dashboardUid: targetUid,
        dashboardTitle,
        removedPanelTitle,
        panelId,
        version,
    };
}

export function formatPanelRemoveReply(result: ProgrammaticPanelRemoveResult, buildNumber: number): string {
    if (result.ok) {
        return (
            `### Panel removed (Graft build ${buildNumber})\n\n` +
            `- **Removed:** ${result.removedPanelTitle ?? '?'}` +
            (result.panelId != null ? ` (id ${result.panelId})` : '') +
            `\n- **Dashboard:** ${result.dashboardTitle ?? '(untitled)'} — uid \`${result.dashboardUid ?? '?'}\`` +
            (result.version != null ? `\n- **Version:** ${result.version}` : '') +
            `\n\nHard-refresh the dashboard (**Cmd+Shift+R**) to confirm the panel is gone.`
        );
    }
    if (result.clarification && result.error) {
        return result.error;
    }
    return (
        `### Could not remove panel (Graft build ${buildNumber})\n\n` +
        `${result.error ?? 'Graft could not remove the panel automatically.'}`
    );
}
