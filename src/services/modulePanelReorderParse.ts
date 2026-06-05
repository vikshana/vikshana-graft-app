import { extractAllDashboardUids, extractDashboardUidFromMessage } from './dashboardMentionParse';
import { extractRequestedDashboardTitle, findMachineIdsInText } from './dashboardCloneParse';
import { latestNonContinueUserMessage } from './dashboardCloneProgress';

export interface ModulePanelReorderRequest {
    dashboardUid?: string;
    dashboardTitle?: string;
    /** When false, skip RandomForest / Influx ML panels. Default true. */
    includeRandomForest: boolean;
}

function normalizeMessageQuotes(text: string): string {
    return text.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
}

/** Panel title starts with Module N Current (History, peer band, RF, etc.). */
export const MODULE_CURRENT_TITLE_RE = /^Module\s*(\d+)\s+Current\b/i;

export function parseModuleNumberFromTitle(title: string): number | null {
    const m = title.trim().match(MODULE_CURRENT_TITLE_RE);
    if (!m?.[1]) {
        return null;
    }
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) ? n : null;
}

export function userWantsModulePanelReorder(message: string): boolean {
    const text = normalizeMessageQuotes(message.trim());
    if (!text) {
        return false;
    }
    const mentionsModuleCurrent =
        MODULE_CURRENT_TITLE_RE.test(text) ||
        /\bmodule\s*["']?\s*\+\s*number\s*\+\s*["']?\s*current\b/i.test(text) ||
        (/\bmodule\s*\d+\b/i.test(text) && /\bcurrent\b/i.test(text));
    if (!mentionsModuleCurrent) {
        return false;
    }
    return (
        /\bre-?\s*arrang(e|ing|ement)\b/i.test(text) ||
        /\bre-?\s*order(ing)?\b/i.test(text) ||
        /\borganiz(e|ing)\b/i.test(text) ||
        (/\bordered?\s+by\s+number\b/i.test(text) && /\b(panel|module)\b/i.test(text)) ||
        (/\bsame\s+size\b/i.test(text) && /\bmodule\b/i.test(text))
    );
}

export function assistantAwaitingModuleReorderConfirm(assistantContent: string): boolean {
    const text = assistantContent.trim();
    if (!text) {
        return false;
    }
    return (
        /Module\s*1\s*→\s*2/i.test(text) ||
        /reordered to\s*\*\*Module\s*1/i.test(text) ||
        /Should I also move the Module\s*5 RandomForest/i.test(text) ||
        (/RandomForest panels/i.test(text) && /\bkeep them at the end\b/i.test(text))
    );
}

export function isModuleReorderConfirmation(message: string): boolean {
    const text = normalizeMessageQuotes(message.trim());
    if (!text || /^continue\.?$/i.test(text)) {
        return false;
    }
    if (userWantsModulePanelReorder(text)) {
        return false;
    }
    return (
        /^(yes|yep|yeah|sure|ok|okay|go ahead|do it|please|confirmed)\b/i.test(text) ||
        (/\byes\b/i.test(text) &&
            /\b(order|including|randomforest|influx|end|ones at end|as well)\b/i.test(text)) ||
        (/\bin order\b/i.test(text) && /\b(including|randomforest|module|end)\b/i.test(text))
    );
}

export function formatModulePanelReorderExamplePrompt(dashboardTitle = '2406-176021 / Exsolve'): string {
    return (
        `On dashboard "${dashboardTitle}", rearrange all panels whose titles start with "Module N Current" ` +
        `to Module 1 through 8 in numeric order, same panel size (full width). Include RandomForest Influx panels in module order.`
    );
}

export function parseModulePanelReorderRequest(
    message: string,
    context?: { priorUserMessage?: string; priorAssistantMessage?: string }
): ModulePanelReorderRequest | null {
    const text = normalizeMessageQuotes(message.trim());
    let source = text;
    let includeRandomForest = /\brandomforest\b/i.test(text) || /\binflux\b/i.test(text);

    if (isModuleReorderConfirmation(text)) {
        const prior = context?.priorUserMessage?.trim();
        const assistant = context?.priorAssistantMessage?.trim() ?? '';
        if (
            !prior ||
            (!userWantsModulePanelReorder(prior) && !assistantAwaitingModuleReorderConfirm(assistant))
        ) {
            return null;
        }
        source = prior;
        includeRandomForest =
            includeRandomForest ||
            /\b(including|randomforest|influx|end|ones at end|as well)\b/i.test(text) ||
            /\byes\b/i.test(text);
    } else if (!userWantsModulePanelReorder(text)) {
        return null;
    } else {
        includeRandomForest = true;
    }

    const uids = extractAllDashboardUids(source);
    const machines = findMachineIdsInText(source);
    const machineId = machines[0];
    const dashboardUid = uids[0] ?? extractDashboardUidFromMessage(source);
    let dashboardTitle = extractRequestedDashboardTitle(source, machineId);
    if (!dashboardTitle && machineId) {
        const slash = source.match(
            new RegExp(`\\b${machineId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\/\\s*[^.,\\n"]+`, 'i')
        );
        if (slash?.[0]) {
            dashboardTitle = slash[0].trim();
        }
    }
    if (!dashboardTitle && /\bon\s+dashboard\s+([0-9]{4}-[0-9]+)\s*\/\s*(\S+)/i.test(source)) {
        const m = source.match(/\bon\s+dashboard\s+([0-9]{4}-[0-9]+)\s*\/\s*(\S+)/i);
        if (m) {
            dashboardTitle = `${m[1]} / ${m[2]}`;
        }
    }

    if (!dashboardUid && !dashboardTitle) {
        return null;
    }

    return {
        dashboardUid,
        dashboardTitle,
        includeRandomForest,
    };
}

/** Resolve reorder intent from recent chat (for Continue or short confirmations). */
export function resolveModulePanelReorderFromHistory(
    recentUserMessages: string[],
    lastAssistantMessage?: string
): ModulePanelReorderRequest | null {
    const latest = recentUserMessages[recentUserMessages.length - 1]?.trim() ?? '';
    const prior = latestNonContinueUserMessage(recentUserMessages.slice(0, -1)) ?? latestNonContinueUserMessage(recentUserMessages);
    return parseModulePanelReorderRequest(latest, {
        priorUserMessage: prior,
        priorAssistantMessage: lastAssistantMessage,
    });
}
