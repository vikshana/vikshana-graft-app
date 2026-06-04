import type { ToolExecution } from '../types/llm.types';
import { latestNonContinueUserMessage, userWantsDashboardPanelFix } from './dashboardCloneProgress';
import { extractDashboardUidFromMessage } from './dashboardMentionParse';
import { parseSearchHitsFromToolExecutions } from './dashboardSearchParse';
import {
    getPanelFixRevertedCount,
    getPanelFixResolvedPanel,
    getPanelFixScope,
    getPanelFixBaseline,
    clearPanelFixNoSaveStreak,
    recordPanelFixNoSaveTurn,
    getPanelFixNoSaveStreak,
} from './panelFixSessionStorage';
import { parseScopedPanelFixRequest } from './panelFixScope';
import { formatScopedPanelCrossReference } from './panelCrossReference';
import { appendSuggestedQueryHint } from './suggestedQueryHint';
import { formatContinueActionBlock } from './continueAction';
import { stripPanelIndexTables } from './dashboardTaskStatus';
import { userWantsBulkPeerBandFix } from './bulkPeerBandFixParse';

export function extractDashboardTitleFromFixRequest(message: string): string | undefined {
    const named = message.match(/\bnamed\s+"([^"]+)"/i);
    if (named?.[1]) {
        return named[1].trim();
    }
    const m = message.match(/\b(?:on|for)\s+([0-9]{4}-[0-9]+\s*\/\s*[^\n."]+)/i);
    return m?.[1]?.trim();
}

export function extractPanelNameFromIssueRequest(message: string): string | undefined {
    const named = message.match(/\bpanel\s+named\s+"([^"]+)"/i);
    return named?.[1]?.trim();
}

export function extractMachineSwapFromFixRequest(message: string): { from?: string; to?: string } {
    const stillUse = message.match(/\bstill use\s+([0-9]{4}-[0-9]+)\s+instead of\s+([0-9]{4}-[0-9]+)/i);
    if (stillUse) {
        return { from: stillUse[1], to: stillUse[2] };
    }
    const generic = message.match(/\b([0-9]{4}-[0-9]+)\s+instead of\s+([0-9]{4}-[0-9]+)/i);
    if (generic) {
        return { from: generic[1], to: generic[2] };
    }
    return {};
}

/** Panel titles from model reply or user request. */
export function extractPanelsMentionedInFixReply(text: string, userRequest = ''): string[] {
    const names: string[] = [];
    const fromUser = extractPanelNameFromIssueRequest(userRequest);
    if (fromUser) {
        names.push(fromUser);
    }
    for (const m of text.matchAll(/\bpanel\s+\*\*([^*]+)\*\*/gi)) {
        const name = m[1]?.trim();
        if (name) {
            names.push(name);
        }
    }
    for (const m of text.matchAll(/Updated (?:the )?\*\*([^*]+)\*\*/gi)) {
        const name = m[1]?.trim();
        if (name) {
            names.push(name);
        }
    }
    return [...new Set(names)];
}

function dashboardTitleFromTools(toolExecutions: ToolExecution[]): string | undefined {
    const hits = parseSearchHitsFromToolExecutions(toolExecutions);
    return hits[0]?.title;
}

function savedVersionFromReply(text: string, toolExecutions: ToolExecution[]): string | undefined {
    const fromText = text.match(/\bversion\s+(\d+)\b/i)?.[1];
    if (fromText) {
        return fromText;
    }
    for (const t of toolExecutions) {
        const v = t.summary?.match(/version=(\d+)/)?.[1];
        if (v) {
            return v;
        }
    }
    return undefined;
}

function isBulkPanelFix(userRequest: string, modelText: string): boolean {
    if (userWantsBulkPeerBandFix(userRequest)) {
        return true;
    }
    const blob = `${userRequest} ${modelText}`;
    return (
        /\ball\s+\d+\s+panels?\b/i.test(blob) ||
        (/\bstill use\b/i.test(userRequest) && /\bpanels?\b/i.test(userRequest))
    );
}

function panelCountFromBulkPeerBandReply(modelText: string): number | undefined {
    const fromFixed = modelText.match(/Fixed\s+\*\*(\d+)\*\*/i)?.[1];
    if (fromFixed) {
        return Number(fromFixed);
    }
    const fromSaved = modelText.match(/\*\*(\d+)\*\*\s+[“"]vs\. Peer Band/i)?.[1];
    if (fromSaved) {
        return Number(fromSaved);
    }
    return undefined;
}

function panelCountFromBulkFix(modelText: string): number | undefined {
    const m = modelText.match(/\ball\s+(\d+)\s+panels?\b/i);
    return m ? Number(m[1]) : undefined;
}

function describeFixKind(userRequest: string, modelText: string): string {
    const swap = extractMachineSwapFromFixRequest(userRequest);
    if (swap.from && swap.to) {
        return `machine labels **${swap.from}** → **${swap.to}**`;
    }
    const blob = `${userRequest} ${modelText}`;
    if (/\baggregateWindow\b/i.test(blob)) {
        return 'query updated with `aggregateWindow()` (fewer datapoints)';
    }
    if (/\b(truncat|too many datapoints)\b/i.test(blob)) {
        return 'query updated to reduce datapoints';
    }
    if (/\bStatus:\s*500\b/i.test(blob)) {
        return 'query error addressed';
    }
    return 'panel updated';
}

export function shouldUseConcisePanelReply(
    content: string,
    toolExecutions: ToolExecution[],
    recentUserMessages: string[] = [],
    fallbackUserMessage = ''
): boolean {
    if (isPanelFixSession(recentUserMessages, fallbackUserMessage)) {
        return true;
    }
    if (fallbackUserMessage.trim() && isPanelFixUserMessage(fallbackUserMessage)) {
        return true;
    }
    const latest = latestNonContinueUserMessage(recentUserMessages) ?? fallbackUserMessage.trim();
    if (!latest || /\b(visual copy|clone|copy of|new dashboard)\b/i.test(latest)) {
        return false;
    }
    const saved = toolExecutions.some((t) => t.name === 'update_dashboard' && t.status === 'success');
    const hasPanelIndex =
        content.includes('Panel index') ||
        toolExecutions.some((t) => t.userReference?.includes('Panel index'));
    return Boolean(saved && hasPanelIndex && (/\bpanel\b/i.test(latest) || /\bdashboard\b/i.test(latest)));
}

export function isPanelFixUserMessage(message: string): boolean {
    return userWantsDashboardPanelFix(message.trim());
}

export function isPanelFixSession(
    recentUserMessages: string[],
    fallbackUserMessage = ''
): boolean {
    if (fallbackUserMessage.trim() && isPanelFixUserMessage(fallbackUserMessage)) {
        return true;
    }
    const latest = latestNonContinueUserMessage(recentUserMessages) ?? fallbackUserMessage.trim();
    return Boolean(latest && isPanelFixUserMessage(latest));
}

/** Model claimed success without a tool save (lookup-only turn). */
export function modelClaimsPanelFixComplete(modelText: string): boolean {
    return (
        /\*\*Done\*\*/i.test(modelText) ||
        /\bdashboard is complete\b/i.test(modelText) ||
        /\bno additional updates needed\b/i.test(modelText) ||
        /\ball panels reference\b/i.test(modelText) ||
        /\bis ready\b/i.test(modelText)
    );
}

/** Short note above the status block (status always last). */
export function extractBriefModelNoteForPanelFix(modelText: string): string | undefined {
    const stripped = stripPanelIndexTables(modelText);
    const lines = stripped
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .filter(
            (l) =>
                !/^#{1,3}\s/.test(l) &&
                !/\*\*Done\*\*/i.test(l) &&
                !/^Done[.!]?\s*$/i.test(l) &&
                !/^Next steps?:/i.test(l) &&
                !/^Dashboard \*\*/i.test(l) &&
                !/^---$/.test(l) &&
                !/^\d+\.\s/.test(l) &&
                l.length < 220
        );
    const note = lines.slice(0, 2).join(' ').trim();
    return note || undefined;
}

export function assemblePanelFixReply(
    briefNote: string | undefined,
    statusBlock: string,
    footer = ''
): string {
    const status = `${statusBlock.trim()}${footer}`;
    const note = briefNote?.trim();
    if (note) {
        return `${note}\n\n---\n\n${status}`;
    }
    return status;
}

/** Plain-English reply for panel fix / error requests (no UID / panel index tables). */
export function applyOperatorFriendlyPanelFixReply(
    content: string,
    toolExecutions: ToolExecution[],
    recentUserMessages: string[] = [],
    fallbackUserMessage = '',
    options?: { finalize?: boolean }
): string {
    const finalize = options?.finalize ?? true;
    const latest = latestNonContinueUserMessage(recentUserMessages) ?? fallbackUserMessage.trim();
    if (!shouldUseConcisePanelReply(content, toolExecutions, recentUserMessages, fallbackUserMessage)) {
        return stripPanelIndexTables(content);
    }

    const stripped = stripPanelIndexTables(content);
    const saved = toolExecutions.some((t) => t.name === 'update_dashboard' && t.status === 'success');
    const lastUpdateFail = [...toolExecutions]
        .reverse()
        .find((t) => t.name === 'update_dashboard' && t.status === 'error');
    const scoped = getPanelFixScope() ?? parseScopedPanelFixRequest(latest);
    const dashboardUid = scoped?.dashboardUid ?? extractDashboardUidFromMessage(latest);
    const baseline = getPanelFixBaseline();
    const dashboardTitle =
        typeof baseline?.title === 'string' && baseline.title.trim()
            ? baseline.title.trim()
            : extractDashboardTitleFromFixRequest(latest) ??
              dashboardTitleFromTools(toolExecutions);
    const dashboard = dashboardTitle
        ? `**${dashboardTitle}** (uid \`${dashboardUid ?? '?'}\`)`
        : dashboardUid
          ? `dashboard uid \`${dashboardUid}\``
          : 'your dashboard';
    const panelsFixed = extractPanelsMentionedInFixReply(stripped, latest);
    const panelLabel =
        panelsFixed.length > 0
            ? panelsFixed.map((p) => `**${p}**`).join(', ')
            : '**the panel**';
    const panelScopeLabel = scoped
        ? formatScopedPanelCrossReference(latest, scoped, getPanelFixResolvedPanel())
        : panelLabel;
    const revertedNote =
        getPanelFixRevertedCount() > 0
            ? ` Other panels were left unchanged (${getPanelFixRevertedCount()} unintended edits reverted).`
            : scoped
              ? ' Other panels were left unchanged.'
              : '';
    const fixKind = describeFixKind(latest, stripped);
    const version = savedVersionFromReply(stripped, toolExecutions);
    const versionBit = version ? ` (version ${version})` : '';

    const refreshLine =
        dashboardTitle && dashboardUid
            ? `**What to do:** Hard-refresh **${dashboardTitle}** (uid \`${dashboardUid}\`) in Grafana (**Cmd+Shift+R** on Mac). ` +
              `If a panel still shows **Error** or **No data**, name that panel here (no UIDs or index numbers).`
            : dashboardUid
              ? `**What to do:** Hard-refresh the dashboard (uid \`${dashboardUid}\`) in Grafana (**Cmd+Shift+R** on Mac). ` +
                `If a panel still shows **Error** or **No data**, name that panel here.`
              : `**What to do:** Hard-refresh the dashboard in Grafana (**Cmd+Shift+R** on Mac). ` +
                `If a panel still shows **Error** or **No data**, name that panel here.`;

    if (saved) {
        clearPanelFixNoSaveStreak();
        const swap = extractMachineSwapFromFixRequest(latest);
        let status: string;
        if (userWantsBulkPeerBandFix(latest)) {
            const count = panelCountFromBulkPeerBandReply(stripped);
            const countLabel =
                count != null
                    ? `**${count}** “vs. Peer Band” panels`
                    : `all matching “vs. Peer Band” panels`;
            status =
                `### Done (panel fix)\n\n` +
                `${dashboard} — ${countLabel} updated with the same Flux query pattern as Module 5. ` +
                `Dashboard saved${versionBit}. Other panels were left unchanged.\n\n` +
                refreshLine;
            return panelFixReplyWithHint(undefined, status, latest, toolExecutions);
        }
        if (isBulkPanelFix(latest, stripped)) {
            const count = panelCountFromBulkFix(stripped) ?? panelCountFromBulkPeerBandReply(stripped);
            const countLine =
                count != null ? ` All **${count} panels**` : ' All panels';
            const swapLine =
                swap.from && swap.to
                    ? ` now use **${swap.to}** only (replaced **${swap.from}**).`
                    : swap.to
                      ? ` now use **${swap.to}** only.`
                      : ` updated (${fixKind}).`;
            const mentionedPanel = extractPanelsMentionedInFixReply(stripped, latest);
            const extraPanel =
                mentionedPanel.length > 0
                    ? ` Also fixed **${mentionedPanel[mentionedPanel.length - 1]}**.`
                    : '';
            status =
                `### Done (panel fix)\n\n` +
                `${dashboard} —${countLine}${swapLine}${extraPanel} Dashboard saved${versionBit}.\n\n` +
                refreshLine;
        } else {
            status =
                `### Done (panel fix)\n\n` +
                `${dashboard} — ${scoped ? panelScopeLabel : panelLabel}: ${fixKind}. Dashboard saved${versionBit}.${revertedNote}\n\n` +
                refreshLine;
        }
        return panelFixReplyWithHint(extractBriefModelNoteForPanelFix(stripped), status, latest, toolExecutions);
    }

    if (modelClaimsPanelFixComplete(stripped)) {
        const swap = extractMachineSwapFromFixRequest(latest);
        const target = swap.to ?? 'the target machine';
        const status =
            `### Done (panel fix)\n\n` +
            `${dashboard} — Graft checked this dashboard; panels already reference **${target}**` +
            (swap.from ? ` (not **${swap.from}**)` : '') +
            `. No save was needed this turn.\n\n` +
            refreshLine;
        return panelFixReplyWithHint(extractBriefModelNoteForPanelFix(stripped), status, latest, toolExecutions);
    }

    const failedSavesThisTurn = toolExecutions.filter(
        (t) => t.name === 'update_dashboard' && t.status === 'error'
    ).length;
    const noSaveStreak = finalize ? recordPanelFixNoSaveTurn() : getPanelFixNoSaveStreak();
    const failDetail = lastUpdateFail?.error
        ? `\n\n**Last save error:** ${lastUpdateFail.error.slice(0, 500)}`
        : '';
    const turnFailLine =
        failedSavesThisTurn > 1
            ? `\n\n**This turn:** ${failedSavesThisTurn} failed \`update_dashboard\` tool calls (Graft stopped retrying automatically).`
            : '';

    if (scoped && finalize && noSaveStreak >= 2) {
        const status =
            `### Stuck — panel fix not saved\n\n` +
            `${dashboard} — ${panelScopeLabel}: Graft could not save this panel after ${noSaveStreak} chat attempts.${failDetail}${turnFailLine}\n\n` +
            `**What to do:**\n` +
            `1. Click **Revert last changes** (header) if other panels were affected.\n` +
            `2. Reply **Continue** once — Graft will retry the save automatically.\n` +
            `3. Or edit queries B–D manually in Grafana.`;
        return panelFixReplyWithHint(undefined, status, latest, toolExecutions);
    }

    const continueDetail = scoped
        ? 'Graft will run the save step now (dashboard uid and panel id are already set).'
        : 'If you reply manually, include dashboard uid and panel id.';

    const status =
        `### Not finished yet\n\n` +
        `${dashboard} — ${scoped ? panelScopeLabel : panelLabel}: no confirmed save this turn.${failDetail}\n\n` +
        formatContinueActionBlock(continueDetail);
    return panelFixReplyWithHint(undefined, status, latest, toolExecutions);
}

function panelFixReplyWithHint(
    briefNote: string | undefined,
    statusBlock: string,
    latest: string,
    toolExecutions: ToolExecution[]
): string {
    return appendSuggestedQueryHint(
        assemblePanelFixReply(briefNote, statusBlock),
        latest,
        toolExecutions
    );
}
