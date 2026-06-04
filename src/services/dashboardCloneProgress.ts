import type { ToolExecution } from '../types/llm.types';
import { getActiveCloneIntent } from './cloneSessionStorage';
import { mentionsDashboard } from './dashboardMentionParse';
import { isDashboardDataInvestigationQuestion } from './dashboardInvestigation';
import { userWantsBulkPeerBandFix } from './bulkPeerBandFixParse';
import { isCrossDashboardPeerBandCopyIntent } from './peerBandShared';
import { messageDescribesDashboardRename } from './dashboardRenameParse';
import { isExplicitScopedPanelFixCommand } from './panelFixScope';
import { messageMentionsSinglePanelCopyIntent } from './singlePanelCopyParse';

export interface DashboardPanelCount {
    uid: string;
    title?: string;
    panelCount: number;
}

export interface IncompleteCloneProgress {
    sourceUid: string;
    sourceTitle?: string;
    sourcePanels: number;
    targetUid: string;
    targetTitle?: string;
    targetPanels: number;
}

/** User asked to clone/copy a dashboard layout to another machine or title. */
export function userWantsDashboardClone(userContent: string): boolean {
    if (isCrossDashboardPeerBandCopyIntent(userContent)) {
        return false;
    }
    if (messageMentionsSinglePanelCopyIntent(userContent)) {
        return false;
    }
    if (messageDescribesDashboardRename(userContent)) {
        return false;
    }
    const wantsCopy =
        /\b(visual copy|clone|copy of|new dashboard)\b/i.test(userContent) ||
        (/\bcreate a dashboard\b/i.test(userContent) && /\bcopy of\b/i.test(userContent));
    return wantsCopy && /\b(dashboard|panel)/i.test(userContent);
}

/** User asked to fix or troubleshoot a panel on an existing dashboard (not a new clone). */
export function userWantsDashboardPanelFix(userContent: string): boolean {
    if (isCrossDashboardPeerBandCopyIntent(userContent)) {
        return false;
    }
    if (messageMentionsSinglePanelCopyIntent(userContent)) {
        return false;
    }
    if (messageDescribesDashboardRename(userContent)) {
        return false;
    }
    if (userWantsDashboardClone(userContent)) {
        return false;
    }
    if (isDashboardDataInvestigationQuestion(userContent)) {
        return false;
    }
    if (userWantsBulkPeerBandFix(userContent)) {
        return true;
    }
    const aboutPanel = /\bpanels?\b/i.test(userContent);
    const aboutDashboard =
        mentionsDashboard(userContent) ||
        /\bnamed\s+"/i.test(userContent) ||
        /\b(?:on|for)\s+[0-9]{4}-[0-9]+\s*(?:\/\s*[^\n.,"]+)?/i.test(userContent);
    if (!aboutPanel || !aboutDashboard) {
        return false;
    }
    if (isExplicitScopedPanelFixCommand(userContent)) {
        return true;
    }
    return (
        /\b(fix|repair|correct)\b/i.test(userContent) ||
        /\bupdate\s+panels?\b/i.test(userContent) ||
        /\bshows?\s+(no data|these\s+errors?|errors?)\b/i.test(userContent) ||
        /\b(still get|these errors|i get|getting)\b.*\b(error|errors)\b/i.test(userContent) ||
        /\b(aggregateWindow|truncat|too many datapoints|Status:\s*500)\b/i.test(userContent) ||
        /\bStatus:\s*400\b/i.test(userContent) ||
        /\bunexpected argument\b/i.test(userContent) ||
        /\bundefined identifier\b/i.test(userContent) ||
        /\bparse error\b/i.test(userContent) ||
        /\bstill use\b/i.test(userContent)
    );
}

/** Most recent user message that is not a bare Continue. */
export function latestNonContinueUserMessage(recentUserMessages: string[]): string | undefined {
    for (let i = recentUserMessages.length - 1; i >= 0; i--) {
        const msg = recentUserMessages[i]?.trim() ?? '';
        if (!msg) {
            continue;
        }
        if (/^continue\.?$/i.test(msg)) {
            continue;
        }
        return msg;
    }
    return undefined;
}

/** Find the original plain-English clone request (skips "Continue" follow-ups). */
export function resolveDashboardCloneIntent(recentUserMessages: string[]): string | undefined {
    const latest = latestNonContinueUserMessage(recentUserMessages);
    if (latest && userWantsDashboardPanelFix(latest)) {
        return undefined;
    }
    if (latest && !userWantsDashboardClone(latest) && !/^continue/i.test(latest)) {
        return undefined;
    }

    const stored = getActiveCloneIntent();
    if (stored && userWantsDashboardClone(stored)) {
        return stored;
    }

    for (let i = recentUserMessages.length - 1; i >= 0; i--) {
        const msg = recentUserMessages[i]?.trim() ?? '';
        if (!msg) {
            continue;
        }
        if (/^continue\b/i.test(msg) && !userWantsDashboardClone(msg)) {
            continue;
        }
        if (userWantsDashboardPanelFix(msg)) {
            return undefined;
        }
        if (userWantsDashboardClone(msg)) {
            return msg;
        }
    }
    return undefined;
}

export function isDashboardCloneSession(recentUserMessages: string[]): boolean {
    return resolveDashboardCloneIntent(recentUserMessages) !== undefined;
}

/** Parse panel index tables attached to tool steps. */
export function parsePanelCountsFromToolExecutions(
    toolExecutions: ToolExecution[]
): DashboardPanelCount[] {
    const byUid = new Map<string, DashboardPanelCount>();

    for (const step of toolExecutions) {
        const ref = step.userReference?.trim();
        if (!ref || !ref.includes('Panel index')) {
            continue;
        }
        const header = ref.match(/\*\*Panel index\*\* — uid `([^`]+)`(?: · ([^\n]+))?/);
        if (!header) {
            continue;
        }
        const uid = header[1];
        const title = header[2]?.trim();
        const rows = ref.match(/^\| \*\*\d+\*\* \|/gm);
        const panelCount = rows?.length ?? 0;
        byUid.set(uid, { uid, title, panelCount });
    }

    return Array.from(byUid.values());
}

/** Infer source (template) vs target (new/partial) from panel counts and user text. */
export function getIncompleteCloneProgress(
    userContent: string,
    toolExecutions: ToolExecution[],
    cloneIntentMessage?: string
): IncompleteCloneProgress | null {
    const intent = cloneIntentMessage ?? userContent;
    if (!userWantsDashboardClone(intent)) {
        return null;
    }

    const counts = parsePanelCountsFromToolExecutions(toolExecutions);
    if (counts.length < 2) {
        return null;
    }

    const sorted = [...counts].sort((a, b) => b.panelCount - a.panelCount);
    const source = sorted[0];
    if (source.panelCount < 3) {
        return null;
    }

    const nameMatch = intent.match(/named\s+"([^"]+)"/i);
    const requestedTitle = nameMatch?.[1]?.trim().toLowerCase();

    let target =
        (requestedTitle
            ? counts.find((c) => c.title?.toLowerCase() === requestedTitle)
            : undefined) ??
        sorted.find((c) => c.uid !== source.uid && c.panelCount < source.panelCount) ??
        sorted[sorted.length - 1];

    if (!target || target.uid === source.uid) {
        return null;
    }

    if (target.panelCount >= source.panelCount) {
        return null;
    }

    return {
        sourceUid: source.uid,
        sourceTitle: source.title,
        sourcePanels: source.panelCount,
        targetUid: target.uid,
        targetTitle: target.title,
        targetPanels: target.panelCount,
    };
}

export function formatIncompleteCloneNotice(progress: IncompleteCloneProgress): string {
    const remaining = progress.sourcePanels - progress.targetPanels;
    const lastIndex = progress.sourcePanels - 1;
    const targetLabel = progress.targetTitle
        ? `${progress.targetTitle} (\`${progress.targetUid}\`)`
        : `\`${progress.targetUid}\``;
    const sourceLabel = progress.sourceTitle
        ? `${progress.sourceTitle} (\`${progress.sourceUid}\`)`
        : `\`${progress.sourceUid}\``;

    return (
        `**Dashboard clone in progress:** ${targetLabel} has **${progress.targetPanels} of ${progress.sourcePanels}** panels copied from ${sourceLabel}. ` +
        `${remaining} panel(s) still to add (arrayIndex **${progress.targetPanels}–${lastIndex}**). ` +
        `Graft should continue automatically; if it stopped, reply **Continue** to finish the clone.`
    );
}

export function assistantPromisesMorePanels(assistantContent: string): boolean {
    return /\b(remaining panels|add all (?:remaining|other) panels|next batch|panels? \d+[-–]\d+|Now I'll add)\b/i.test(
        assistantContent
    );
}
