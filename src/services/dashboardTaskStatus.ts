import type { ToolExecution } from '../types/llm.types';
import { formatContinueActionBlock } from './continueAction';
import {
    getIncompleteCloneProgress,
    parsePanelCountsFromToolExecutions,
    resolveDashboardCloneIntent,
    userWantsDashboardClone,
    type DashboardPanelCount,
} from './dashboardCloneProgress';
import {
    clearActiveCloneIntent,
    clearCloneNotStartedStreak,
    countContinueMessages,
    getCloneSessionMeta,
    recordCloneNotStartedResponse,
    updateCloneSessionMeta,
} from './cloneSessionStorage';
import {
    extractMachineFromRequest,
    extractRequestedDashboardTitle,
    extractSourceMachineId,
    extractTargetMachineId,
    getEffectiveCloneFieldsFromIntent,
    isMachineId,
    parseCloneIntentMessage,
} from './dashboardCloneParse';
import { appendSuggestedQueryHint } from './suggestedQueryHint';
import { findDashboardByTitle, parseSearchHitsFromToolExecutions } from './dashboardSearchParse';

export type CloneTaskState = 'complete' | 'in_progress' | 'not_started' | 'stuck';

export interface CloneTaskStatus {
    state: CloneTaskState;
    requestedTitle?: string;
    requestedMachine?: string;
    sourceTitle?: string;
    sourceUid?: string;
    sourcePanels?: number;
    targetTitle?: string;
    targetUid?: string;
    targetPanels?: number;
    continueAttempts?: number;
}

export { extractMachineFromRequest, extractRequestedDashboardTitle, extractSourceMachineId, extractTargetMachineId };

export function getSavedDashboardFromTools(
    toolExecutions: ToolExecution[]
): { uid?: string; version?: string } {
    for (const t of toolExecutions) {
        if (t.name === 'update_dashboard' && t.status === 'success' && t.summary) {
            const uid = t.summary.match(/uid=([^\s,]+)/)?.[1];
            const version = t.summary.match(/version=(\d+)/)?.[1];
            return { uid, version };
        }
    }
    return {};
}

function pickSourceAndTarget(
    counts: DashboardPanelCount[],
    requestedTitle?: string
): { source?: DashboardPanelCount; target?: DashboardPanelCount } {
    if (counts.length === 0) {
        return {};
    }
    const sorted = [...counts].sort((a, b) => b.panelCount - a.panelCount);
    const source = sorted[0];
    const titleLower = requestedTitle?.toLowerCase();
    const target =
        (titleLower ? counts.find((c) => c.title?.toLowerCase() === titleLower) : undefined) ??
        sorted.find((c) => c.uid !== source.uid) ??
        (sorted.length > 1 ? sorted[sorted.length - 1] : undefined);
    return { source, target };
}

/** Panel counts align (rows/extra chrome can add ±2 vs template). */
export function panelCountsMatchClone(sourcePanels: number, targetPanels: number): boolean {
    if (targetPanels < sourcePanels - 1) {
        return false;
    }
    return Math.abs(targetPanels - sourcePanels) <= 2;
}

/** Resolve clone intent from conversation (handles "Continue" follow-ups). */
export function resolveCloneIntentForSession(
    recentUserMessages: string[],
    fallbackMessage = ''
): string | undefined {
    return resolveDashboardCloneIntent(recentUserMessages) ?? (userWantsDashboardClone(fallbackMessage) ? fallbackMessage : undefined);
}

/** Persist source/target uids from tool steps for Continue prompts. */
export function syncCloneSessionFromTools(cloneIntentMessage: string, toolExecutions: ToolExecution[]): void {
    const requestedTitle = extractRequestedDashboardTitle(cloneIntentMessage);
    const counts = parsePanelCountsFromToolExecutions(toolExecutions);
    const sorted = [...counts].sort((a, b) => b.panelCount - a.panelCount);
    const source = sorted[0];
    const hits = parseSearchHitsFromToolExecutions(toolExecutions);
    const targetHit = requestedTitle ? findDashboardByTitle(hits, requestedTitle) : undefined;
    const targetFromCounts = requestedTitle
        ? counts.find((c) => c.title?.toLowerCase() === requestedTitle.toLowerCase())
        : undefined;

    const targetMachine =
        extractTargetMachineId(cloneIntentMessage) ?? extractMachineFromRequest(cloneIntentMessage);

    const effective = getEffectiveCloneFieldsFromIntent(cloneIntentMessage);
    updateCloneSessionMeta({
        intent: cloneIntentMessage,
        requestedTitle: effective.requestedTitle ?? requestedTitle,
        requestedMachine: effective.requestedMachine ?? targetMachine,
        sourceMachineId: effective.sourceMachineId ?? extractSourceMachineId(cloneIntentMessage),
        sourceUid: source?.uid,
        sourceTitle: source?.title,
        targetUid: targetHit?.uid ?? targetFromCounts?.uid,
    });
}

/** Operator-facing status for plain-English dashboard clone requests. */
export function assessCloneTask(
    cloneIntentMessage: string,
    toolExecutions: ToolExecution[],
    recentUserMessages: string[] = []
): CloneTaskStatus | null {
    if (!cloneIntentMessage || !userWantsDashboardClone(cloneIntentMessage)) {
        return null;
    }

    const effective = getEffectiveCloneFieldsFromIntent(cloneIntentMessage);
    const requestedMachine = effective.requestedMachine;
    const requestedTitle = effective.requestedTitle;
    const meta = getCloneSessionMeta();

    if (
        meta?.cloneSourcePanelSlots != null &&
        meta.cloneTargetPanelSlotsSaved != null &&
        meta.cloneTargetPanelSlotsSaved < meta.cloneSourcePanelSlots
    ) {
        return {
            state: 'in_progress',
            requestedTitle: meta.requestedTitle ?? requestedTitle,
            requestedMachine:
                requestedMachine ??
                (meta.requestedMachine && isMachineId(meta.requestedMachine)
                    ? meta.requestedMachine
                    : undefined),
            sourceTitle: meta.sourceTitle,
            sourceUid: meta.sourceUid,
            sourcePanels: meta.cloneSourcePanelSlots,
            targetTitle: meta.requestedTitle ?? requestedTitle,
            targetUid: meta.targetUid,
            targetPanels: meta.cloneTargetPanelSlotsSaved,
        };
    }

    const incomplete = getIncompleteCloneProgress(cloneIntentMessage, toolExecutions, cloneIntentMessage);

    if (incomplete) {
        return {
            state: 'in_progress',
            requestedTitle,
            requestedMachine,
            sourceTitle: incomplete.sourceTitle,
            sourceUid: incomplete.sourceUid,
            sourcePanels: incomplete.sourcePanels,
            targetTitle: incomplete.targetTitle ?? requestedTitle,
            targetUid: incomplete.targetUid,
            targetPanels: incomplete.targetPanels,
        };
    }

    const counts = parsePanelCountsFromToolExecutions(toolExecutions);
    const saved = getSavedDashboardFromTools(toolExecutions);
    const { source, target } = pickSourceAndTarget(counts, requestedTitle);

    const base = {
        requestedTitle,
        requestedMachine,
        sourceTitle: source?.title,
        sourceUid: source?.uid,
        sourcePanels: source?.panelCount,
        targetTitle: target?.title ?? requestedTitle,
        targetUid: target?.uid ?? saved.uid,
        targetPanels: target?.panelCount,
    };

    const hadSave = Boolean(saved.uid);
    const continueAttempts = Math.max(
        meta?.continueAttempts ?? 0,
        countContinueMessages(recentUserMessages)
    );
    const sourceUid = source?.uid ?? meta?.sourceUid;
    const sourceTitle = source?.title ?? meta?.sourceTitle ?? 'the source dashboard';

    const sameDashboard =
        source && target && source.uid === target.uid && source.panelCount >= 3;
    const panelCountSatisfied =
        source &&
        target &&
        panelCountsMatchClone(source.panelCount, target.panelCount);

    if (sameDashboard && panelCountSatisfied) {
        return {
            state: 'complete',
            ...base,
            targetTitle: target.title ?? base.targetTitle,
            targetPanels: target.panelCount,
            sourcePanels: source.panelCount,
        };
    }

    if (
        hadSave &&
        source &&
        target &&
        target.uid !== source.uid &&
        panelCountSatisfied
    ) {
        return { state: 'complete', ...base, targetPanels: target.panelCount, sourcePanels: source.panelCount };
    }

    if (hadSave && source && target && target.uid !== source.uid) {
        return { state: 'in_progress', ...base };
    }

    if (hadSave && sameDashboard && panelCountSatisfied) {
        return {
            state: 'complete',
            ...base,
            targetUid: saved.uid ?? target.uid,
            targetPanels: target.panelCount,
            sourcePanels: source.panelCount,
        };
    }

    if (hadSave) {
        const tgtPanels = target?.panelCount;
        const srcPanels = source?.panelCount;
        if (
            tgtPanels != null &&
            srcPanels != null &&
            panelCountsMatchClone(srcPanels, tgtPanels) &&
            (source?.uid === target?.uid || !target?.uid)
        ) {
            return {
                state: 'complete',
                ...base,
                targetUid: saved.uid ?? target?.uid,
                targetPanels: tgtPanels,
                sourcePanels: srcPanels,
            };
        }
        return {
            state: 'in_progress',
            ...base,
            targetUid: saved.uid,
            targetPanels: target?.panelCount,
            sourcePanels: source?.panelCount,
        };
    }

    const notStartedStreak = meta?.notStartedStreak ?? 0;
    const shouldStuck =
        !hadSave &&
        (source || sourceUid || counts.length > 0) &&
        (continueAttempts >= 2 || notStartedStreak >= 2);

    if (shouldStuck) {
        return {
            state: 'stuck',
            ...base,
            sourcePanels: source?.panelCount ?? base.sourcePanels,
            sourceTitle,
            sourceUid,
            continueAttempts: Math.max(continueAttempts, notStartedStreak, 2),
        };
    }

    if (!hadSave && (source || counts.length > 0 || sourceUid)) {
        return {
            state: 'not_started',
            ...base,
            sourcePanels: source?.panelCount ?? counts[0]?.panelCount,
            sourceTitle,
            sourceUid,
            continueAttempts,
        };
    }

    if (!hadSave) {
        return {
            state: 'not_started',
            requestedTitle,
            requestedMachine,
            continueAttempts,
        };
    }

    return null;
}

const CONTINUE_HINT = formatContinueActionBlock(
    'This is a **full dashboard clone** (all panels from the source layout). ' +
        'To copy **one panel only**, say: `Create a new panel on the TARGET dashboard that is a copy of the "PANEL TITLE" panel on SOURCE`.'
);

const CONTINUE_HINT_NOT_STARTED = formatContinueActionBlock(
    'Graft looked up the source dashboard but has not saved the target yet.'
);

export function formatPlainEnglishCloneStatus(status: CloneTaskStatus, cloneIntent?: string): string {
    const effective = cloneIntent ? getEffectiveCloneFieldsFromIntent(cloneIntent) : null;
    const displayMachine =
        status.requestedMachine && isMachineId(status.requestedMachine)
            ? status.requestedMachine
            : effective?.requestedMachine;
    const machineLine = displayMachine ? ` Target machine is **${displayMachine}**.` : '';
    const templateMachine = cloneIntent ? extractSourceMachineId(cloneIntent) : undefined;

    switch (status.state) {
        case 'complete': {
            const name = status.targetTitle || status.requestedTitle || 'Your dashboard';
            const srcN = status.sourcePanels;
            const tgtN = status.targetPanels;
            let panelLine = 'all panels copied';
            if (srcN != null && tgtN != null) {
                panelLine =
                    tgtN === srcN
                        ? `${tgtN} panels (same as template)`
                        : `${tgtN} panels (template had ${srcN})`;
            } else if (tgtN != null) {
                panelLine = `${tgtN} panels`;
            }
            const fixHint =
                templateMachine && status.requestedMachine
                    ? `*Fix panels on ${name} that show errors or still use ${templateMachine} instead of ${status.requestedMachine}.*`
                    : `*Fix panels on ${name} that show errors or No data.*`;
            return (
                `### Done (layout copied)\n\n` +
                `**${name}** — ${panelLine}.${machineLine}\n\n` +
                `**What this means:** Graft finished saving the dashboard layout. It does **not** guarantee every panel loads correctly.\n\n` +
                `**What to do:**\n` +
                `1. Open **Dashboards** → **${name}**, then hard-refresh (**Cmd+Shift+R** on Mac).\n` +
                `2. Scroll the dashboard: red **Error** or **No data** on a panel means that panel still needs work.\n` +
                `3. If needed, ask Graft: ${fixHint}`
            );
        }
        case 'in_progress': {
            const name = status.targetTitle || status.requestedTitle || 'The new dashboard';
            const src = status.sourceTitle || 'the template dashboard';
            const have = status.targetPanels ?? 0;
            const total = status.sourcePanels ?? '?';
            const sameName =
                status.sourceTitle &&
                status.targetTitle &&
                status.sourceTitle.toLowerCase() === status.targetTitle.toLowerCase();
            if (
                typeof total === 'number' &&
                have >= total - 1 &&
                (sameName || status.sourceUid === status.targetUid)
            ) {
                return formatPlainEnglishCloneStatus(
                    { ...status, state: 'complete' },
                    cloneIntent
                );
            }
            const meta = getCloneSessionMeta();
            const chunkLine =
                meta?.cloneTotalChunks && meta.cloneTotalChunks > 1 && meta.cloneChunkIndex != null
                    ? ` (${meta.cloneChunkIndex} of ${meta.cloneTotalChunks} save batches done)`
                    : '';
            return (
                `### Not finished yet\n\n` +
                `**${name}** has **${have} of ${total}** panels copied from **${src}**${chunkLine}.${machineLine}\n\n` +
                CONTINUE_HINT
            );
        }
        case 'not_started': {
            const sessionMeta = getCloneSessionMeta();
            const dest = status.requestedTitle || 'your new dashboard';
            const src = status.sourceTitle || 'the source dashboard';
            const panels = status.sourcePanels != null ? ` (${status.sourcePanels} panels)` : '';
            const savedSoFar =
                sessionMeta?.cloneTargetPanelSlotsSaved != null &&
                sessionMeta.cloneSourcePanelSlots != null
                    ? ` (**${sessionMeta.cloneTargetPanelSlotsSaved} of ${sessionMeta.cloneSourcePanelSlots}** panels saved so far — reply **Continue** to resume.)`
                    : '';
            return (
                `### Not finished yet\n\n` +
                `Graft looked up **${src}**${panels} but has **not saved** **${dest}** yet.${savedSoFar}${machineLine}\n\n` +
                CONTINUE_HINT_NOT_STARTED
            );
        }
        case 'stuck': {
            const dest = status.requestedTitle || 'your new dashboard';
            const srcUid = status.sourceUid ?? 'the template uid from search';
            const srcMachine = templateMachine ?? 'the source machine';
            const tgtMachine = status.requestedMachine ?? 'the target machine';
            return (
                `### Stuck — automatic save failed\n\n` +
                `Graft could not save **${dest}** after multiple tries.${machineLine}\n\n` +
                `**What to do:** Hard-refresh this page (**Cmd+Shift+R**), then send your original clone request again in a **new chat**. ` +
                `If it still fails, ask your admin to confirm Grafana MCP allows \`update_dashboard\` for your role.\n\n` +
                `**Technical fallback** (one message):\n\n` +
                `Clone dashboard uid=${srcUid} to a new dashboard titled "${dest}". ` +
                `Replace all machine labels ${srcMachine} with ${tgtMachine} in every panel, then call update_dashboard and confirm save.`
            );
        }
    }
}

/** Remove panel index markdown blocks from assistant text (operators use plain-English status instead). */
export function stripPanelIndexTables(text: string): string {
    let out = text;
    out = out.replace(/\n---\n\*\*Panel index\*\*[\s\S]*?(?=\n---\n|$)/g, '');
    out = out.replace(/\n\*\*Panel index\*\*[\s\S]*?(?=\n\*\*Cite in requests|\n---\n|$)/g, '');
    out = out.replace(/\*\*Panel index\*\*[\s\S]*?(?=\*\*Cite in requests|$)/g, '');
    out = out.replace(/\n\*\*Dashboard lookup reference\*\*[\s\S]*?(?=\n---\n|$)/g, '');
    out = out.replace(/\n---\n\*\*Dashboard lookup reference\*\*[\s\S]*?(?=\n---\n|$)/g, '');
    out = out.replace(/\*\*Dashboard lookup reference\*\*[\s\S]*?(?=\*\*Panel index\*\*|$)/g, '');
    out = out.replace(/\n\*\*Next steps?:\*\*[\s\S]*?(?=\n---\n|$)/gi, '');
    out = out.replace(/\n\*\*Cite in requests:\*\*[\s\S]*$/gi, '');
    return out.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * For plain-English clone sessions: show only clear Done / Not finished status.
 * Hides model planning text and panel index tables from the chat bubble.
 */
export function applyOperatorFriendlyDashboardReply(
    content: string,
    toolExecutions: ToolExecution[],
    recentUserMessages: string[] = [],
    fallbackUserMessage = ''
): string {
    const cloneIntent = resolveCloneIntentForSession(recentUserMessages, fallbackUserMessage);
    if (!cloneIntent) {
        return stripPanelIndexTables(content);
    }

    syncCloneSessionFromTools(cloneIntent, toolExecutions);

    const status = assessCloneTask(cloneIntent, toolExecutions, recentUserMessages);
    if (status?.state === 'complete') {
        clearActiveCloneIntent();
        clearCloneNotStartedStreak();
    }

    if (status?.state === 'not_started') {
        recordCloneNotStartedResponse();
    } else if (status?.state === 'in_progress' || status?.state === 'complete') {
        clearCloneNotStartedStreak();
        if (
            status.state === 'in_progress' &&
            status.sourcePanels != null &&
            status.targetPanels != null
        ) {
            updateCloneSessionMeta({
                cloneSourcePanelSlots: status.sourcePanels,
                cloneTargetPanelSlotsSaved: status.targetPanels,
                requestedTitle: status.targetTitle ?? status.requestedTitle,
                sourceUid: status.sourceUid,
                targetUid: status.targetUid,
                sourceTitle: status.sourceTitle,
            });
        }
    }

    if (!status) {
            return (
                `### Not finished yet\n\n` +
                `Graft is still working on **${extractRequestedDashboardTitle(cloneIntent) ?? 'your dashboard'}**.` +
                formatContinueActionBlock()
            );
    }

    const formatted = formatPlainEnglishCloneStatus(status, cloneIntent);
    const userMsg =
        fallbackUserMessage.trim() ||
        recentUserMessages.filter((m) => !/^continue\.?$/i.test(m.trim())).pop() ||
        '';
    return appendSuggestedQueryHint(formatted, userMsg || cloneIntent || '', toolExecutions);
}
