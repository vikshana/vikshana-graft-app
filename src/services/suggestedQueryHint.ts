import type { ToolExecution } from '../types/llm.types';
import {
    extractSourceMachineId,
    extractTargetMachineId,
    getEffectiveCloneFieldsFromIntent,
} from './dashboardCloneParse';
import { isDashboardDataInvestigationQuestion } from './dashboardInvestigation';
import { userWantsDashboardClone, userWantsDashboardPanelFix } from './dashboardCloneProgress';
import { parseBulkPeerBandFixRequest, userWantsBulkPeerBandFix, formatBulkPeerBandFixExamplePrompt } from './bulkPeerBandFixParse';
import {
    formatPeerBandPanelCopyExamplePrompt,
    parsePeerBandPanelCopyRequest,
    userWantsPeerBandPanelCopy,
} from './peerBandPanelCopyParse';
import { extractPanelIdFromMessage, extractDashboardUidFromMessage } from './dashboardMentionParse';
import { parseScopedPanelFixRequest } from './panelFixScope';
import { extractMachineSwapFromFixRequest, extractPanelNameFromIssueRequest } from './dashboardPanelFixReply';
import { parseSearchHitsFromToolExecutions } from './dashboardSearchParse';

export type SuggestedQueryTask =
    | 'panel_fix_scoped'
    | 'panel_fix_bulk_peer_band'
    | 'peer_band_panel_copy'
    | 'panel_fix'
    | 'clone'
    | 'investigation';

export interface SuggestedQueryContext {
    task: SuggestedQueryTask;
    userMessage: string;
    dashboardUid?: string;
    dashboardTitle?: string;
    panelId?: number;
    panelTitle?: string;
    sourceMachine?: string;
    targetMachine?: string;
    sourceUid?: string;
}

function normalizeForCompare(text: string): string {
    return text
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/[`'"]/g, '')
        .trim();
}

function extractIssuePhrase(userMessage: string): string | undefined {
    const fluxInvalid = userMessage.match(/\bunexpected argument\b/i);
    if (fluxInvalid) {
        return 'Flux query invalid (check group by / stdDev syntax)';
    }
    const status = userMessage.match(/\bStatus:\s*\d+[^.\n]*/i)?.[0];
    if (status) {
        return status.trim().slice(0, 80);
    }
    const parseErr = userMessage.match(/\bparse error:[^.\n]+/i)?.[0];
    if (parseErr) {
        return parseErr.trim().slice(0, 80);
    }
    if (/\bno data\b/i.test(userMessage)) {
        return 'shows No data';
    }
    if (/\bstill use\b/i.test(userMessage)) {
        const swap = extractMachineSwapFromFixRequest(userMessage);
        if (swap.from && swap.to) {
            return `still use ${swap.from} instead of ${swap.to}`;
        }
    }
    if (/\b(error|errors)\b/i.test(userMessage)) {
        return 'shows errors';
    }
    return undefined;
}

export function buildSuggestedQuery(ctx: SuggestedQueryContext): string | null {
    const issue = extractIssuePhrase(ctx.userMessage);
    const issueSuffix = issue ? `: ${issue}` : '';

    if (ctx.task === 'panel_fix_scoped' && ctx.dashboardUid) {
        const panelPart =
            ctx.panelId != null
                ? `panel id **${ctx.panelId}**`
                : ctx.panelTitle
                  ? `panel "${ctx.panelTitle}"`
                  : 'panel';
        const titleBit = ctx.panelTitle && ctx.panelId != null ? ` ("${ctx.panelTitle}")` : '';
        return (
            `Fix only ${panelPart} on dashboard uid ${ctx.dashboardUid}${titleBit}. ` +
            `Do not change other panels${issueSuffix}. ` +
            `(Use panel **name** if panel id points at the wrong panel — check get_dashboard_summary.)`
        ).replace(/\*\*/g, '');
    }

    if (ctx.task === 'panel_fix_bulk_peer_band' && ctx.dashboardUid) {
        return formatBulkPeerBandFixExamplePrompt(ctx.dashboardUid);
    }

    if (ctx.task === 'peer_band_panel_copy' && ctx.dashboardUid) {
        const targets =
            parsePeerBandPanelCopyRequest(ctx.userMessage)?.targetDashboardUids ?? ['TARGET_UID_1'];
        return formatPeerBandPanelCopyExamplePrompt(ctx.dashboardUid, targets);
    }

    if (ctx.task === 'panel_fix') {
        const dash =
            ctx.dashboardUid != null
                ? `dashboard uid ${ctx.dashboardUid}`
                : ctx.dashboardTitle
                  ? `dashboard "${ctx.dashboardTitle}"`
                  : 'dashboard';
        const panel =
            ctx.panelId != null
                ? `panel id ${ctx.panelId}`
                : ctx.panelTitle
                  ? `panel "${ctx.panelTitle}"`
                  : extractPanelNameFromIssueRequest(ctx.userMessage)
                    ? `panel "${extractPanelNameFromIssueRequest(ctx.userMessage)}"`
                    : 'panel';
        return `Fix ${panel} on ${dash}${issueSuffix}. Include dashboard uid and panel id when you can.`;
    }

    if (ctx.task === 'clone') {
        const target = ctx.targetMachine ?? 'TARGET_MACHINE';
        const source = ctx.sourceMachine ?? 'SOURCE_MACHINE';
        const title =
            ctx.dashboardTitle ?? `${target} / SiteName`;
        return (
            `Create dashboard "${title}" — copy of ${source}` +
            (ctx.sourceUid ? ` (template uid ${ctx.sourceUid})` : '') +
            `, with data for machine ${target}.`
        );
    }

    if (ctx.task === 'investigation') {
        const dash = ctx.dashboardUid
            ? `dashboard uid ${ctx.dashboardUid}`
            : ctx.dashboardTitle
              ? `dashboard "${ctx.dashboardTitle}"`
              : 'dashboard';
        const panel =
            ctx.panelId != null
                ? `panel id ${ctx.panelId}`
                : ctx.panelTitle
                  ? `panel "${ctx.panelTitle}"`
                  : 'panel';
        return `On ${dash}, ${panel}: why no data for [your time range]? Explain only — do not edit other panels.`;
    }

    return null;
}

/** True if the suggested query would not meaningfully improve on what the user already sent. */
export function userAlreadyUsedConciseQuery(userMessage: string, suggested: string): boolean {
    const u = normalizeForCompare(userMessage);
    const s = normalizeForCompare(suggested);
    if (u.length > 0 && s.includes(u.slice(0, Math.min(40, u.length)))) {
        return true;
    }
    if (parseScopedPanelFixRequest(userMessage) && /\bfix only\b/i.test(suggested)) {
        if (!/\bfix only\b/i.test(userMessage)) {
            return false;
        }
        const uId = extractPanelIdFromMessage(userMessage);
        const sId = extractPanelIdFromMessage(suggested);
        if (uId != null && sId != null && uId === sId && /\buid\b/i.test(userMessage)) {
            return true;
        }
        if (extractDashboardUidFromMessage(userMessage) && /\bpanel\s+named\b/i.test(userMessage)) {
            return true;
        }
    }
    return false;
}

export function formatSuggestedQueryFooter(ctx: SuggestedQueryContext): string {
    const suggested = buildSuggestedQuery(ctx);
    if (!suggested || userAlreadyUsedConciseQuery(ctx.userMessage, suggested)) {
        return '';
    }
    return (
        `\n\n---\n\n` +
        `**Faster next time** — shorter queries use fewer tokens. Paste something like:\n\n` +
        `\`${suggested}\``
    );
}

export function buildSuggestedQueryContext(
    userMessage: string,
    toolExecutions: ToolExecution[] = []
): SuggestedQueryContext | null {
    const text = userMessage.trim();
    if (!text || /^continue\.?$/i.test(text) || /^revert last dashboard/i.test(text)) {
        return null;
    }

    const scoped = parseScopedPanelFixRequest(text);
    const hits = parseSearchHitsFromToolExecutions(toolExecutions);
    const uidFromTools = hits[0]?.uid;
    const titleFromTools = hits[0]?.title;

    const bulkPeerBand = parseBulkPeerBandFixRequest(text);
    if (bulkPeerBand && userWantsBulkPeerBandFix(text)) {
        return {
            task: 'panel_fix_bulk_peer_band',
            userMessage: text,
            dashboardUid: bulkPeerBand.dashboardUid,
            dashboardTitle: titleFromTools,
            panelTitle: bulkPeerBand.titleContains,
        };
    }

    const peerBandCopy = parsePeerBandPanelCopyRequest(text);
    if (peerBandCopy && userWantsPeerBandPanelCopy(text)) {
        return {
            task: 'peer_band_panel_copy',
            userMessage: text,
            dashboardUid: peerBandCopy.sourceDashboardUid,
            sourceUid: peerBandCopy.sourceDashboardUid,
            dashboardTitle: titleFromTools,
            panelTitle: peerBandCopy.titleContains,
        };
    }

    if (scoped) {
        return {
            task: 'panel_fix_scoped',
            userMessage: text,
            dashboardUid: scoped.dashboardUid,
            panelId: scoped.panelId,
            panelTitle: scoped.panelTitle,
            dashboardTitle: titleFromTools,
        };
    }

    if (userWantsDashboardPanelFix(text)) {
        return {
            task: 'panel_fix',
            userMessage: text,
            dashboardUid: uidFromTools,
            dashboardTitle: titleFromTools,
            panelId: undefined,
            panelTitle: extractPanelNameFromIssueRequest(text),
            targetMachine: extractTargetMachineId(text),
            sourceMachine: extractMachineSwapFromFixRequest(text).from,
        };
    }

    if (userWantsDashboardClone(text)) {
        const effective = getEffectiveCloneFieldsFromIntent(text);
        return {
            task: 'clone',
            userMessage: text,
            dashboardTitle: effective.requestedTitle,
            sourceMachine: effective.sourceMachineId ?? extractSourceMachineId(text),
            targetMachine: effective.requestedMachine ?? extractTargetMachineId(text),
            sourceUid: undefined,
        };
    }

    if (isDashboardDataInvestigationQuestion(text)) {
        const invScoped = parseScopedPanelFixRequest(text);
        return {
            task: 'investigation',
            userMessage: text,
            dashboardUid: invScoped?.dashboardUid ?? uidFromTools,
            panelId: invScoped?.panelId,
            panelTitle: invScoped?.panelTitle,
            dashboardTitle: titleFromTools,
        };
    }

    if (/\b(dashboard|panel)\b/i.test(text) && (uidFromTools || titleFromTools)) {
        return {
            task: 'panel_fix',
            userMessage: text,
            dashboardUid: uidFromTools,
            dashboardTitle: titleFromTools,
        };
    }

    return null;
}

export function appendSuggestedQueryHint(
    reply: string,
    userMessage: string,
    toolExecutions: ToolExecution[] = []
): string {
    const ctx = buildSuggestedQueryContext(userMessage, toolExecutions);
    if (!ctx) {
        return reply;
    }
    const footer = formatSuggestedQueryFooter(ctx);
    if (!footer || reply.includes('**Faster next time**')) {
        return reply;
    }
    return `${reply.trim()}${footer}`;
}
