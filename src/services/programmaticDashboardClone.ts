import type { ToolExecution } from '../types/llm.types';
import { callMcpTool, parseJsonFromMcpText } from './mcpToolClient';
import {
    findMachineIdsInText,
    getEffectiveCloneFieldsFromIntent,
    isMachineId,
    parseCloneIntentMessage,
} from './dashboardCloneParse';
import { findDashboardByTitle, parseSearchHitsFromMcpText } from './dashboardSearchParse';
import {
    enrichDashboardToolResult,
    formatPanelIndexFromDashboardJson,
    getDashboardUserReference,
} from './dashboardReference';
import { splitPanelsIntoChunks } from './dashboardCloneChunks';
import { saveDashboardInPanelChunks, type McpClient } from './dashboardChunkedUpdate';
import {
    clearCloneChunkProgress,
    getCloneSessionMeta,
    updateCloneSessionMeta,
} from './cloneSessionStorage';
import { userWantsDashboardClone } from './dashboardCloneProgress';
import { formatContinueActionBlock } from './continueAction';

export interface ProgrammaticCloneResult {
    ok: boolean;
    error?: string;
    targetUid?: string;
    targetVersion?: number;
    panelCount?: number;
    targetTitle?: string;
    sourceMachine?: string;
    targetMachine?: string;
    chunksSaved?: number;
    totalChunks?: number;
    toolExecutions: ToolExecution[];
}

interface DashboardSearchHit {
    uid: string;
    title: string;
}

function parseSearchHits(text: string): DashboardSearchHit[] {
    return parseSearchHitsFromMcpText(text);
}

export function extractDashboardFromGetByUid(text: string): {
    dashboard: Record<string, unknown>;
    meta?: Record<string, unknown>;
} | null {
    const parsed = parseJsonFromMcpText(text);
    if (!parsed || typeof parsed !== 'object') {
        return null;
    }
    const root = parsed as Record<string, unknown>;
    const dashboard = root.dashboard;
    if (!dashboard || typeof dashboard !== 'object') {
        return null;
    }
    const meta = root.meta;
    return {
        dashboard: dashboard as Record<string, unknown>,
        meta: meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : undefined,
    };
}

/** Deep-replace machine id strings in dashboard JSON (queries, titles, variables). */
export function replaceMachineLabelsInValue(
    value: unknown,
    sourceMachine: string,
    targetMachine: string
): unknown {
    if (sourceMachine === targetMachine) {
        return value;
    }
    if (typeof value === 'string') {
        return value.split(sourceMachine).join(targetMachine);
    }
    if (Array.isArray(value)) {
        return value.map((v) => replaceMachineLabelsInValue(v, sourceMachine, targetMachine));
    }
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            out[k] = replaceMachineLabelsInValue(v, sourceMachine, targetMachine);
        }
        return out;
    }
    return value;
}

export function countPanelsInDashboard(dashboard: Record<string, unknown>): number {
    const panels = dashboard.panels;
    if (!Array.isArray(panels)) {
        return 0;
    }
    let n = 0;
    for (const p of panels) {
        if (!p || typeof p !== 'object') {
            continue;
        }
        const po = p as { type?: string; panels?: unknown[] };
        if (po.type === 'row' && Array.isArray(po.panels)) {
            n += po.panels.length;
        } else if (po.type !== 'row') {
            n += 1;
        }
    }
    return n;
}

export function prepareClonedDashboard(
    source: Record<string, unknown>,
    opts: {
        targetTitle: string;
        sourceMachine: string;
        targetMachine: string;
        targetUid?: string;
        targetNumericId?: number;
    }
): Record<string, unknown> {
    const cloned = replaceMachineLabelsInValue(
        JSON.parse(JSON.stringify(source)),
        opts.sourceMachine,
        opts.targetMachine
    ) as Record<string, unknown>;

    cloned.title = opts.targetTitle;

    if (opts.targetUid) {
        cloned.uid = opts.targetUid;
        if (opts.targetNumericId != null) {
            cloned.id = opts.targetNumericId;
        }
    } else {
        delete cloned.uid;
        delete cloned.id;
    }

    return cloned;
}

function pendingTool(name: string): ToolExecution {
    return { name, status: 'pending', summary: undefined };
}

function finishTool(
    step: ToolExecution,
    outcome: { ok: boolean; error?: string; summary?: string; userReference?: string }
): ToolExecution {
    return {
        ...step,
        status: outcome.ok ? 'success' : 'error',
        error: outcome.error,
        summary: outcome.summary,
        userReference: outcome.userReference,
    };
}

async function resolveSourceUid(
    mcpClient: McpClient,
    sourceMachine: string,
    metaUid: string | undefined,
    toolExecutions: ToolExecution[]
): Promise<{ uid?: string; error?: string }> {
    if (metaUid) {
        return { uid: metaUid };
    }

    const searchStep = pendingTool('search_dashboards');
    toolExecutions.push(searchStep);
    const search = await callMcpTool(mcpClient, 'search_dashboards', { query: sourceMachine });
    toolExecutions[toolExecutions.length - 1] = finishTool(searchStep, search);
    if (!search.ok) {
        return { error: search.error ?? 'search_dashboards failed' };
    }

    const hits = parseSearchHits(search.text);
    const match =
        hits.find((h) => h.title.includes(sourceMachine)) ??
        hits.find((h) => h.title.toLowerCase().includes(sourceMachine.toLowerCase())) ??
        hits[0];

    if (!match?.uid) {
        return { error: `No dashboard found for machine ${sourceMachine}` };
    }

    updateCloneSessionMeta({ sourceUid: match.uid, sourceTitle: match.title });
    return { uid: match.uid };
}

/**
 * Clone a template dashboard to a new title with machine label substitution.
 * Uses MCP directly so Continue does not depend on the LLM calling update_dashboard.
 */
export async function runProgrammaticDashboardClone(
    mcpClient: McpClient,
    cloneIntentMessage: string
): Promise<ProgrammaticCloneResult> {
    if (!userWantsDashboardClone(cloneIntentMessage)) {
        return { ok: false, error: 'Not a dashboard clone request', toolExecutions: [] };
    }

    const meta = getCloneSessionMeta();
    const parsed = parseCloneIntentMessage(cloneIntentMessage);
    const effective = getEffectiveCloneFieldsFromIntent(cloneIntentMessage);

    if (!parsed.valid) {
        return {
            ok: false,
            error:
                parsed.error ??
                'Could not parse template and target machine ids from your message. Example: copy of 2103-176030 with data for 2505-200033.',
            toolExecutions: [],
        };
    }

    const sourceTitleHint = effective.sourceDashboardTitle ?? parsed.sourceDashboardTitle;
    let sourceMachine = effective.sourceMachineId ?? parsed.sourceMachineId;
    const targetMachine =
        effective.requestedMachine ??
        (meta?.requestedMachine && isMachineId(meta.requestedMachine) ? meta.requestedMachine : undefined);
    let targetTitle = effective.requestedTitle ?? parsed.requestedTitle;

    if ((!sourceMachine && !sourceTitleHint) || !targetMachine || !targetTitle) {
        return {
            ok: false,
            error: 'Missing target title, target machine, or source machine/dashboard name in clone request',
            toolExecutions: [],
        };
    }

    const toolExecutions: ToolExecution[] = [];

    const sourceResolved = await resolveSourceUid(
        mcpClient,
        sourceTitleHint ?? sourceMachine!,
        meta?.sourceUid,
        toolExecutions
    );
    if (!sourceResolved.uid) {
        return { ok: false, error: sourceResolved.error, toolExecutions };
    }

    const getSourceStep = pendingTool('get_dashboard_by_uid');
    toolExecutions.push(getSourceStep);
    const sourceFetch = await callMcpTool(mcpClient, 'get_dashboard_by_uid', { uid: sourceResolved.uid });
    toolExecutions[toolExecutions.length - 1] = finishTool(getSourceStep, {
        ...sourceFetch,
        userReference: sourceFetch.ok ? formatPanelIndexFromDashboardJson(parseJsonFromMcpText(sourceFetch.text)) : undefined,
    });

    if (!sourceFetch.ok) {
        return { ok: false, error: sourceFetch.error, toolExecutions };
    }

    const extracted = extractDashboardFromGetByUid(sourceFetch.text);
    if (!extracted) {
        return { ok: false, error: 'Could not parse source dashboard JSON', toolExecutions };
    }

    if (!sourceMachine) {
        const fromTitle = findMachineIdsInText(String(extracted.dashboard.title ?? ''))[0];
        const fromJson = findMachineIdsInText(JSON.stringify(extracted.dashboard))[0];
        sourceMachine = fromTitle ?? fromJson;
    }
    if (!sourceMachine) {
        return {
            ok: false,
            error:
                `Found template dashboard "${sourceTitleHint ?? sourceResolved.uid}" but could not infer its machine id. ` +
                `Name the template machine (e.g. copy of 2103-176030) or use that dashboard's uid.`,
            toolExecutions,
        };
    }

    const searchTargetStep = pendingTool('search_dashboards');
    toolExecutions.push(searchTargetStep);
    const targetSearch = await callMcpTool(mcpClient, 'search_dashboards', { query: targetMachine });
    toolExecutions[toolExecutions.length - 1] = finishTool(searchTargetStep, targetSearch);

    if (targetSearch.ok) {
        const hits = parseSearchHits(targetSearch.text);
        const byMachine =
            hits.find((h) => h.title.includes(targetMachine)) ??
            hits.find((h) => h.title.toLowerCase().includes(targetMachine.toLowerCase()));
        if (byMachine) {
            targetTitle = byMachine.title;
        }
    }

    let targetUid: string | undefined;
    let targetNumericId: number | undefined;
    let folderUid: string | undefined;

    if (targetSearch.ok) {
        const targetHit = findDashboardByTitle(parseSearchHits(targetSearch.text), targetTitle);
        if (targetHit) {
            targetUid = targetHit.uid;
            const getTargetStep = pendingTool('get_dashboard_by_uid');
            toolExecutions.push(getTargetStep);
            const targetFetch = await callMcpTool(mcpClient, 'get_dashboard_by_uid', { uid: targetUid });
            toolExecutions[toolExecutions.length - 1] = finishTool(getTargetStep, targetFetch);
            if (targetFetch.ok) {
                const targetExtracted = extractDashboardFromGetByUid(targetFetch.text);
                if (targetExtracted) {
                    const id = targetExtracted.dashboard.id;
                    if (typeof id === 'number') {
                        targetNumericId = id;
                    }
                    folderUid =
                        typeof targetExtracted.meta?.folderUid === 'string'
                            ? targetExtracted.meta.folderUid
                            : folderUid;
                }
            }
        }
    }

    if (!folderUid && extracted.meta) {
        const f = extracted.meta.folderUid;
        if (typeof f === 'string') {
            folderUid = f;
        }
    }

    const clonedDashboard = prepareClonedDashboard(extracted.dashboard, {
        targetTitle,
        sourceMachine,
        targetMachine,
        targetUid,
        targetNumericId,
    });

    const panelCount = countPanelsInDashboard(clonedDashboard);

    const resumeChunkIndex = meta?.cloneChunkIndex ?? 0;
    const resumeUid =
        resumeChunkIndex > 0 ? meta?.targetUid ?? targetUid : targetUid;

    const cloneMessagePrefix = `Graft clone ${sourceMachine} → ${targetMachine}`;
    const panelChunks = splitPanelsIntoChunks(
        Array.isArray(clonedDashboard.panels) ? clonedDashboard.panels : []
    );
    updateCloneSessionMeta({
        cloneTotalChunks: panelChunks.length,
        cloneSourcePanelSlots: panelCount,
        requestedTitle: targetTitle,
        requestedMachine: targetMachine,
        sourceMachineId: sourceMachine,
    });

    const chunkedSave = await saveDashboardInPanelChunks(
        mcpClient,
        clonedDashboard,
        {
            folderUid,
            targetUid: resumeUid,
            overwrite: Boolean(resumeUid ?? targetUid),
            messagePrefix: cloneMessagePrefix,
            startChunkIndex: resumeChunkIndex > 0 ? resumeChunkIndex : 0,
            resumeTargetUid: resumeChunkIndex > 0 ? resumeUid : undefined,
            onChunkSaved: ({ chunkIndex, totalChunks, uid }) => {
                let cumulative = 0;
                for (let i = 0; i <= chunkIndex; i++) {
                    cumulative += panelChunks[i]?.length ?? 0;
                }
                updateCloneSessionMeta({
                    cloneChunkIndex: chunkIndex + 1,
                    cloneTotalChunks: totalChunks,
                    cloneSourcePanelSlots: panelCount,
                    cloneTargetPanelSlotsSaved: cumulative,
                    targetUid: uid,
                    requestedTitle: targetTitle,
                    requestedMachine: targetMachine,
                });
            },
        },
        toolExecutions
    );

    if (chunkedSave.ok) {
        clearCloneChunkProgress();
    } else if (chunkedSave.uid) {
        updateCloneSessionMeta({
            cloneChunkIndex: chunkedSave.chunksSaved,
            cloneTotalChunks: chunkedSave.totalChunks,
            targetUid: chunkedSave.uid,
        });
    }

    if (!chunkedSave.ok) {
        const chunkHint =
            chunkedSave.totalChunks > 1
                ? ` Saved ${chunkedSave.chunksSaved}/${chunkedSave.totalChunks} panel chunks. Reply **Continue** to resume.`
                : '';
        return {
            ok: false,
            error: (chunkedSave.error ?? 'Chunked save failed') + chunkHint,
            targetUid: chunkedSave.uid,
            targetTitle,
            sourceMachine,
            targetMachine,
            chunksSaved: chunkedSave.chunksSaved,
            totalChunks: chunkedSave.totalChunks,
            toolExecutions,
        };
    }

    const savedUid = chunkedSave.uid;

    updateCloneSessionMeta({
        sourceUid: sourceResolved.uid,
        targetUid: savedUid,
        requestedTitle: targetTitle,
        requestedMachine: targetMachine,
    });

    if (savedUid) {
        const summaryStep = pendingTool('get_dashboard_summary');
        toolExecutions.push(summaryStep);
        const summary = await callMcpTool(mcpClient, 'get_dashboard_summary', { uid: savedUid });
        const enriched = summary.ok ? enrichDashboardToolResult('get_dashboard_summary', summary.text) : summary.text;
        toolExecutions[toolExecutions.length - 1] = finishTool(summaryStep, {
            ...summary,
            userReference: getDashboardUserReference('get_dashboard_summary', enriched),
        });
    }

    return {
        ok: true,
        targetUid: savedUid,
        panelCount,
        targetTitle,
        sourceMachine,
        targetMachine,
        chunksSaved: chunkedSave.chunksSaved,
        totalChunks: chunkedSave.totalChunks,
        toolExecutions,
    };
}

/** Human-readable reply for a programmatic dashboard clone. */
export function formatDashboardCloneReply(
    result: ProgrammaticCloneResult,
    buildNumber: number
): string {
    if (!result.ok) {
        const partial =
            result.targetUid != null &&
            result.totalChunks != null &&
            result.chunksSaved != null &&
            result.chunksSaved > 0 &&
            result.chunksSaved < result.totalChunks;
        const base =
            `### Could not clone dashboard (Graft build ${buildNumber})\n\n` +
            `${result.error ?? 'Unknown error'}\n\n` +
            `**Example:** Create dashboard "2505-200033 / Keysight" — copy of 2103-176030, with data for machine 2505-200033.`;
        // A partial save is resumable — surface the Continue action so the next
        // run picks up the remaining panel batches from the saved chunk index.
        return partial
            ? base +
                  formatContinueActionBlock(
                      `Dashboard clone not finished — ${result.chunksSaved}/${result.totalChunks} panel batches saved. Resume the rest.`
                  )
            : base;
    }

    const batches =
        result.totalChunks && result.totalChunks > 1
            ? ` in ${result.totalChunks} batches`
            : '';
    return (
        `### Done — dashboard cloned (Graft build ${buildNumber})\n\n` +
        `- **New dashboard:** ${result.targetTitle ?? result.targetUid} (\`${result.targetUid}\`)\n` +
        `- **Panels copied:** ${result.panelCount ?? 'all'}${batches}\n` +
        (result.sourceMachine && result.targetMachine
            ? `- **Machine remap:** ${result.sourceMachine} → ${result.targetMachine}\n`
            : '') +
        `\nAll panels were copied in one pass — no need to type Continue. Hard-refresh the dashboard to see it.`
    );
}
