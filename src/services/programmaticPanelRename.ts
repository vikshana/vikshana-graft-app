import type { ToolExecution } from '../types/llm.types';
import { extractDashboardFromGetByUid } from './programmaticDashboardClone';
import { callMcpTool } from './mcpToolClient';
import type { McpClient } from './dashboardChunkedUpdate';
import { stampDashboardForOverwrite } from './fluxQueryFix';
import { normalizeUpdateDashboardArgs } from './updateDashboardArgs';
import { listDashboardPanels, type DashboardPanelEntry } from './panelDiscovery';
import type { PanelRenameRequest } from './panelRenameParse';
import { formatPanelRenameNotFoundClarification } from './panelRenameParse';
import {
    type DashboardSearchHit,
    parseSearchHitsFromMcpText,
} from './dashboardSearchParse';

export interface ProgrammaticPanelRenameResult {
    ok: boolean;
    error?: string;
    clarification?: boolean;
    toolExecutions: ToolExecution[];
    dashboardUid?: string;
    dashboardTitle?: string;
    previousPanelTitle?: string;
    newPanelTitle?: string;
    panelId?: number;
    version?: number;
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

function normalizeTitle(title: string): string {
    return title.trim().toLowerCase();
}

function findPanelByExactTitle(
    entries: DashboardPanelEntry[],
    title: string
): DashboardPanelEntry | undefined {
    const want = normalizeTitle(title);
    const exact = entries.find((e) => normalizeTitle(e.title) === want);
    if (exact) {
        return exact;
    }
    return entries.find(
        (e) => normalizeTitle(e.title).includes(want) || want.includes(normalizeTitle(e.title))
    );
}

async function resolveDashboardUid(
    mcpClient: McpClient,
    request: PanelRenameRequest,
    toolExecutions: ToolExecution[],
    contextDashboardUid?: string
): Promise<{ uid?: string; title?: string; error?: string; clarification?: string }> {
    if (request.dashboardUid) {
        return { uid: request.dashboardUid };
    }

    const machine = request.machineId;
    if (!machine) {
        return { uid: contextDashboardUid };
    }

    const searchStep = pendingTool('search_dashboards');
    toolExecutions.push(searchStep);
    const search = await callMcpTool(mcpClient, 'search_dashboards', { query: machine });
    toolExecutions[toolExecutions.length - 1] = finishTool(searchStep, search);
    if (!search.ok) {
        return { error: search.error ?? 'search_dashboards failed' };
    }

    const hits = parseSearchHitsFromMcpText(search.text);
    const matching = hits.filter((h) => h.title.includes(machine));
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
                `Multiple dashboards match machine **${machine}**:\n\n${list}\n\n` +
                `Reply with the dashboard **uid**.`,
        };
    }
    if (hits.length === 1) {
        return { uid: hits[0].uid, title: hits[0].title };
    }
    return { uid: contextDashboardUid };
}

export async function runProgrammaticPanelRename(
    mcpClient: McpClient,
    request: PanelRenameRequest,
    opts?: { contextDashboardUid?: string }
): Promise<ProgrammaticPanelRenameResult> {
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
            error: formatPanelRenameNotFoundClarification(request),
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
            error: formatPanelRenameNotFoundClarification(request),
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
    const panelEntry = findPanelByExactTitle(entries, request.currentPanelTitle);
    if (!panelEntry) {
        return {
            ok: false,
            clarification: true,
            error: formatPanelRenameNotFoundClarification(request, {
                dashboardTitle,
                panelTitles: entries.map((e) => e.title).filter(Boolean),
            }),
            toolExecutions,
            dashboardUid: targetUid,
            dashboardTitle,
        };
    }

    const previousPanelTitle = panelEntry.title;
    if (normalizeTitle(previousPanelTitle) === normalizeTitle(request.newPanelTitle)) {
        return {
            ok: false,
            error: `Panel is already titled **${previousPanelTitle}**. Nothing to rename.`,
            toolExecutions,
            dashboardUid: targetUid,
            dashboardTitle,
            previousPanelTitle,
            newPanelTitle: request.newPanelTitle,
            panelId: typeof panelEntry.panel.id === 'number' ? panelEntry.panel.id : undefined,
        };
    }

    const proposed = JSON.parse(JSON.stringify(baseline)) as Record<string, unknown>;
    const proposedEntries = listDashboardPanels(proposed.panels);
    const proposedEntry = findPanelByExactTitle(proposedEntries, request.currentPanelTitle);
    if (!proposedEntry) {
        return { ok: false, error: 'Could not locate panel in dashboard copy', toolExecutions, dashboardUid: targetUid };
    }

    (proposedEntry.panel as Record<string, unknown>).title = request.newPanelTitle;

    const saveStep = pendingTool('update_dashboard');
    toolExecutions.push(saveStep);
    const savePayload = normalizeUpdateDashboardArgs({
        dashboard: stampDashboardForOverwrite(baseline, proposed),
        overwrite: true,
        message: `Graft: rename panel "${previousPanelTitle}" → "${request.newPanelTitle}"`,
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
            previousPanelTitle,
            newPanelTitle: request.newPanelTitle,
            panelId: typeof panelEntry.panel.id === 'number' ? panelEntry.panel.id : undefined,
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
        const savedDashboardTitle =
            typeof verified?.dashboard?.title === 'string' ? verified.dashboard.title : undefined;
        if (savedDashboardTitle && dashboardTitle && savedDashboardTitle !== dashboardTitle) {
            return {
                ok: false,
                error: `Save changed dashboard title to **${savedDashboardTitle}** — expected **${dashboardTitle}** unchanged.`,
                toolExecutions,
                dashboardUid: targetUid,
                dashboardTitle,
                previousPanelTitle,
                newPanelTitle: request.newPanelTitle,
                version,
            };
        }
        const verifiedEntries = listDashboardPanels(verified?.dashboard?.panels);
        const renamed = findPanelByExactTitle(verifiedEntries, request.newPanelTitle);
        if (!renamed) {
            return {
                ok: false,
                error: `Save reported success but panel title is still **${previousPanelTitle}**.`,
                toolExecutions,
                dashboardUid: targetUid,
                dashboardTitle,
                previousPanelTitle,
                newPanelTitle: request.newPanelTitle,
                version,
            };
        }
    }

    return {
        ok: true,
        toolExecutions,
        dashboardUid: targetUid,
        dashboardTitle,
        previousPanelTitle,
        newPanelTitle: request.newPanelTitle,
        panelId: typeof panelEntry.panel.id === 'number' ? panelEntry.panel.id : undefined,
        version,
    };
}

export function formatPanelRenameReply(result: ProgrammaticPanelRenameResult, buildNumber: number): string {
    if (result.ok) {
        return (
            `### Panel renamed (Graft build ${buildNumber})\n\n` +
            `- **Panel:** ${result.previousPanelTitle ?? '?'} → **${result.newPanelTitle ?? '?'}**` +
            (result.panelId != null ? ` (id ${result.panelId})` : '') +
            `\n- **Dashboard:** ${result.dashboardTitle ?? '(untitled)'} — uid \`${result.dashboardUid ?? '?'}\` (title unchanged)` +
            (result.version != null ? `\n- **Version:** ${result.version}` : '') +
            `\n\nHard-refresh the dashboard to see the new panel title.`
        );
    }
    if (result.clarification && result.error) {
        return result.error;
    }
    return (
        `### Could not rename panel (Graft build ${buildNumber})\n\n` +
        `${result.error ?? 'Graft could not rename the panel automatically.'}`
    );
}
