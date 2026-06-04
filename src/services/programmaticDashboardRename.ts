import type { ToolExecution } from '../types/llm.types';
import { extractDashboardFromGetByUid } from './programmaticDashboardClone';
import { callMcpTool } from './mcpToolClient';
import type { McpClient } from './dashboardChunkedUpdate';
import { stampDashboardForOverwrite } from './fluxQueryFix';
import { normalizeUpdateDashboardArgs } from './updateDashboardArgs';
import type { DashboardRenameRequest } from './dashboardRenameParse';
import {
    computeRenamedDashboardTitle,
    formatDashboardRenameAmbiguousClarification,
    formatDashboardRenameNotFoundClarification,
} from './dashboardRenameParse';
import {
    type DashboardSearchHit,
    parseSearchHitsFromMcpText,
} from './dashboardSearchParse';

export interface ProgrammaticDashboardRenameResult {
    ok: boolean;
    error?: string;
    clarification?: boolean;
    toolExecutions: ToolExecution[];
    dashboardUid?: string;
    previousTitle?: string;
    newTitle?: string;
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

function hitMatchesMachine(hit: DashboardSearchHit, machine: string): boolean {
    if (hit.title.includes(machine)) {
        return true;
    }
    return hit.tags?.some((tag) => tag.includes(machine)) ?? false;
}

function scoreDashboardHit(hit: DashboardSearchHit, request: DashboardRenameRequest): number {
    const machine = request.machineId;
    let score = 0;
    if (machine && hitMatchesMachine(hit, machine)) {
        score += 10;
    }
    if (machine && request.replaceLabel) {
        const exactTitle = `${machine} / ${request.replaceLabel}`;
        if (hit.title.trim() === exactTitle) {
            score += 100;
        } else if (hit.title.toLowerCase().includes(request.replaceLabel.toLowerCase())) {
            score += 40;
        }
    } else if (request.replaceLabel && hit.title.toLowerCase().includes(request.replaceLabel.toLowerCase())) {
        score += 20;
    }
    if (machine && new RegExp(`^${machine}\\s*/`).test(hit.title.trim())) {
        score += 15;
    }
    if (request.dashboardUid && hit.uid === request.dashboardUid) {
        score += 200;
    }
    return score;
}

function pickDashboardHit(
    hits: DashboardSearchHit[],
    request: DashboardRenameRequest
): { hit?: DashboardSearchHit; ambiguous?: DashboardSearchHit[] } {
    if (hits.length === 0) {
        return {};
    }

    const ranked = [...hits]
        .map((hit) => ({ hit, score: scoreDashboardHit(hit, request) }))
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score);

    if (ranked.length === 0) {
        return {};
    }

    const topScore = ranked[0].score;
    const topMatches = ranked.filter((row) => row.score === topScore).map((row) => row.hit);
    if (topMatches.length > 1) {
        return { ambiguous: topMatches };
    }
    return { hit: ranked[0].hit };
}

function buildRenameSearchQueries(request: DashboardRenameRequest): string[] {
    if (request.dashboardUid) {
        return [request.dashboardUid];
    }

    const queries: string[] = [];
    const machine = request.machineId;
    const label = request.replaceLabel;

    if (machine && label) {
        queries.push(`${machine} / ${label}`);
        queries.push(`${machine} ${label}`);
    }
    if (machine) {
        queries.push(machine);
    }
    if (label) {
        queries.push(label);
    }

    return [...new Set(queries.map((q) => q.trim()).filter(Boolean))];
}

async function searchDashboardHits(
    mcpClient: McpClient,
    request: DashboardRenameRequest,
    toolExecutions: ToolExecution[]
): Promise<{ hits: DashboardSearchHit[]; searchedQueries: string[]; searchFailed?: string }> {
    const searchedQueries = buildRenameSearchQueries(request);
    let hits: DashboardSearchHit[] = [];

    for (const query of searchedQueries) {
        const searchStep = pendingTool('search_dashboards');
        toolExecutions.push(searchStep);
        const search = await callMcpTool(mcpClient, 'search_dashboards', { query });
        toolExecutions[toolExecutions.length - 1] = finishTool(searchStep, search);
        if (!search.ok) {
            return { hits, searchedQueries, searchFailed: search.error ?? 'search_dashboards failed' };
        }

        const parsed = parseSearchHitsFromMcpText(search.text);
        const byUid = new Map(hits.map((h) => [h.uid, h]));
        for (const hit of parsed) {
            if (!byUid.has(hit.uid)) {
                byUid.set(hit.uid, hit);
                hits.push(hit);
            }
        }

        const pick = pickDashboardHit(hits, request);
        if (pick.hit || pick.ambiguous) {
            break;
        }
    }

    return { hits, searchedQueries };
}

export async function runProgrammaticDashboardRename(
    mcpClient: McpClient,
    request: DashboardRenameRequest,
    opts?: { contextDashboardUid?: string }
): Promise<ProgrammaticDashboardRenameResult> {
    const toolExecutions: ToolExecution[] = [];
    let targetUid = request.dashboardUid;
    let currentTitle: string | undefined;

    if (!targetUid) {
        const { hits, searchedQueries, searchFailed } = await searchDashboardHits(
            mcpClient,
            request,
            toolExecutions
        );
        if (searchFailed && hits.length === 0) {
            return {
                ok: false,
                error: searchFailed,
                toolExecutions,
            };
        }

        let pick = pickDashboardHit(hits, request);

        if (!pick.hit && !pick.ambiguous && opts?.contextDashboardUid) {
            targetUid = opts.contextDashboardUid;
        } else if (pick.ambiguous && pick.ambiguous.length > 1) {
            return {
                ok: false,
                clarification: true,
                error: formatDashboardRenameAmbiguousClarification(request, pick.ambiguous),
                toolExecutions,
            };
        } else if (pick.hit) {
            targetUid = pick.hit.uid;
            currentTitle = pick.hit.title;
        } else if (hits.length === 1) {
            targetUid = hits[0].uid;
            currentTitle = hits[0].title;
        } else {
            return {
                ok: false,
                clarification: true,
                error: formatDashboardRenameNotFoundClarification(request, {
                    searchedQueries,
                    nearbyTitles: hits.map((h) => h.title),
                }),
                toolExecutions,
            };
        }
    }

    const getStep = pendingTool('get_dashboard_by_uid');
    toolExecutions.push(getStep);
    const getResult = await callMcpTool(mcpClient, 'get_dashboard_by_uid', { uid: targetUid! });
    toolExecutions[toolExecutions.length - 1] = finishTool(getStep, getResult);
    if (!getResult.ok) {
        return {
            ok: false,
            clarification: true,
            error: formatDashboardRenameNotFoundClarification(request, {
                searchedQueries: buildRenameSearchQueries(request),
            }),
            toolExecutions,
            dashboardUid: targetUid,
        };
    }

    const extracted = extractDashboardFromGetByUid(getResult.text);
    if (!extracted?.dashboard) {
        return {
            ok: false,
            error: 'Could not parse dashboard JSON',
            toolExecutions,
            dashboardUid: targetUid,
        };
    }

    const baseline = extracted.dashboard;
    currentTitle =
        typeof baseline.title === 'string' ? baseline.title : currentTitle ?? '(untitled)';
    const newTitle = computeRenamedDashboardTitle(currentTitle, {
        machineId: request.machineId,
        replaceLabel: request.replaceLabel,
        newLabel: request.newLabel,
        newTitle: request.newTitle,
    });

    if (newTitle === currentTitle) {
        return {
            ok: false,
            error: `Dashboard title is already **${currentTitle}**. Nothing to rename.`,
            toolExecutions,
            dashboardUid: targetUid,
            previousTitle: currentTitle,
            newTitle,
        };
    }

    const proposed = JSON.parse(JSON.stringify(baseline)) as Record<string, unknown>;
    proposed.title = newTitle;

    const saveStep = pendingTool('update_dashboard');
    toolExecutions.push(saveStep);
    const savePayload = normalizeUpdateDashboardArgs({
        dashboard: stampDashboardForOverwrite(baseline, proposed),
        overwrite: true,
        message: `Graft: rename dashboard to ${newTitle}`,
    });
    const saveResult = await callMcpTool(mcpClient, 'update_dashboard', savePayload);
    toolExecutions[toolExecutions.length - 1] = finishTool(saveStep, saveResult);
    if (!saveResult.ok) {
        return {
            ok: false,
            error: saveResult.error ?? 'update_dashboard failed',
            toolExecutions,
            dashboardUid: targetUid,
            previousTitle: currentTitle,
            newTitle,
        };
    }

    const verifyStep = pendingTool('get_dashboard_by_uid');
    toolExecutions.push(verifyStep);
    const verify = await callMcpTool(mcpClient, 'get_dashboard_by_uid', { uid: targetUid! });
    toolExecutions[toolExecutions.length - 1] = finishTool(verifyStep, verify);

    let version: number | undefined;
    if (verify.ok) {
        const verified = extractDashboardFromGetByUid(verify.text);
        version = typeof verified?.dashboard?.version === 'number' ? verified.dashboard.version : undefined;
        const savedTitle = typeof verified?.dashboard?.title === 'string' ? verified.dashboard.title : undefined;
        if (savedTitle && savedTitle !== newTitle) {
            return {
                ok: false,
                error: `Save reported success but title is still **${savedTitle}**.`,
                toolExecutions,
                dashboardUid: targetUid,
                previousTitle: currentTitle,
                newTitle,
                version,
            };
        }
    }

    return {
        ok: true,
        toolExecutions,
        dashboardUid: targetUid,
        previousTitle: currentTitle,
        newTitle,
        version,
    };
}

export function formatDashboardRenameReply(
    result: ProgrammaticDashboardRenameResult,
    buildNumber: number
): string {
    if (result.ok) {
        return (
            `### Dashboard renamed (Graft build ${buildNumber})\n\n` +
            `- **Before:** ${result.previousTitle ?? '?'}\n` +
            `- **After:** ${result.newTitle ?? '?'}\n` +
            `- **Uid:** \`${result.dashboardUid ?? '?'}\`${result.version != null ? `\n- **Version:** ${result.version}` : ''}\n\n` +
            `Hard-refresh the dashboard list or open the dashboard again to see the new title.`
        );
    }
    if (result.clarification && result.error) {
        return result.error;
    }
    return (
        `### Could not rename dashboard (Graft build ${buildNumber})\n\n` +
        `${result.error ?? 'Graft could not rename the dashboard automatically.'}`
    );
}
