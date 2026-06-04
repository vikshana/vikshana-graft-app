import { extractAllDashboardUids } from './dashboardMentionParse';
import {
    extractTargetMachineId,
    findMachineIdsInText,
    isMachineId,
    MACHINE_ID_PATTERN,
} from './dashboardCloneParse';
import { messageMentionsPeerBandPanelCopyIntent } from './peerBandPanelCopyParse';
import { describesDashboardCloneLayoutIntent } from './dashboardCloneProgress';

export interface SinglePanelCopyRequest {
    panelTitle: string;
    sourceDashboardUid?: string;
    targetDashboardUid?: string;
    sourceDashboardTitle?: string;
    targetDashboardTitle?: string;
    sourceMachineId?: string;
    targetMachineId?: string;
    /** Replace an existing panel on the target when the title matches. Default true. */
    replaceExisting: boolean;
}

function normalizeMessageQuotes(text: string): string {
    return text.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
}

/** One named panel copied to another dashboard — not a full layout clone. */
export function isExplicitSinglePanelCopyRequest(userContent: string): boolean {
    const text = normalizeMessageQuotes(userContent.trim());
    if (!/\bpanel/i.test(text) || !/\b(copy|same as)\b/i.test(text)) {
        return false;
    }
    if (/\b(?:all panels|every panel|entire dashboard|whole dashboard|visual copy of)\b/i.test(text)) {
        return false;
    }
    return (
        /\bcopy of (?:the\s+)?"[^"]+"\s+panel\b/i.test(text) ||
        (/\b(?:new|add|create|make)\b/i.test(text) && /\bpanel\s+on\b/i.test(text) && /\bcopy\b/i.test(text))
    );
}

export function extractPanelTitleFromCopyMessage(message: string): string | undefined {
    const text = normalizeMessageQuotes(message.trim());
    const patterns = [
        /\bsame as the\s+"([^"]+)"\s+panel/i,
        /\bsame as the\s+'([^']+)'\s+panel/i,
        /\bpanel(?:\s+titled|\s+title|\s+named|\s+called)?\s+"([^"]+)"/i,
        /"([^"]+)"\s+panel\s+on/i,
        /\bcopy(?:\s+the)?\s+"([^"]+)"\s+panel/i,
        /\b(?:add|create)\s+(?:a\s+)?(?:new\s+)?panel\s+(?:titled|called|named)?\s+"([^"]+)"/i,
        /\b(?:add|create)\s+(?:a\s+)?(?:new\s+)?panel\s+(?:titled|called|named)?\s+'([^']+)'/i,
    ];
    for (const re of patterns) {
        const match = text.match(re);
        if (match?.[1]?.trim()) {
            return match[1].trim();
        }
    }
    return undefined;
}

export function extractTargetDashboardTitleForPanelCopy(message: string): string | undefined {
    const text = normalizeMessageQuotes(message.trim());
    const onDashboard = text.match(
        /\b(?:new|add|create)\s+(?:a\s+)?panel\s+on\s+(?:the\s+)?(.+?)\s+dashboard\b/i
    );
    if (onDashboard?.[1]?.trim()) {
        return onDashboard[1].trim();
    }
    return undefined;
}

export function extractSourceDashboardTitleForPanelCopy(message: string): string | undefined {
    const text = normalizeMessageQuotes(message.trim());
    const afterPanelTitle = text.match(
        /\bcopy of (?:the\s+)?"[^"]+"\s+panel\s+on\s+(?:the\s+)?(.+?)(?:\s*\.|\s*$)/i
    );
    if (afterPanelTitle?.[1]?.trim()) {
        return afterPanelTitle[1].trim();
    }
    const panelOn = text.match(/\bpanel\s+on\s+(?:the\s+)?(.+?)(?:\s*\.|\s*$)/i);
    if (panelOn?.[1]?.trim() && !/\bdashboard\b/i.test(panelOn[1])) {
        return panelOn[1].trim();
    }
    return undefined;
}

export function extractSourceMachineIdForPanelCopy(message: string): string | undefined {
    const text = normalizeMessageQuotes(message.trim());
    const fromQuotedPanel = text.match(
        new RegExp(
            `\\bcopy of (?:the\\s+)?"[^"]+"\\s+panel\\s+on\\s+(?:the\\s+)?(${MACHINE_ID_PATTERN.source})`,
            'i'
        )
    );
    if (fromQuotedPanel?.[1] && isMachineId(fromQuotedPanel[1])) {
        return fromQuotedPanel[1];
    }
    const patterns = [
        new RegExp(`\\bpanel\\s+on\\s+(?:the\\s+)?(?:dashboard\\s+)?(${MACHINE_ID_PATTERN.source})`, 'i'),
        new RegExp(`\\bfrom\\s+(?:dashboard\\s+)?(${MACHINE_ID_PATTERN.source})`, 'i'),
        new RegExp(`\\bon\\s+(?:the\\s+)?(${MACHINE_ID_PATTERN.source})\\s+(?:machine\\s+)?dashboard`, 'i'),
    ];
    for (const re of patterns) {
        const match = text.match(re);
        if (match?.[1] && isMachineId(match[1])) {
            return match[1];
        }
    }

    const uids = extractAllDashboardUids(text);
    const ids = findMachineIdsInText(text);
    const sourceTitle = extractSourceDashboardTitleForPanelCopy(text);
    if (sourceTitle) {
        const fromTitle = findMachineIdsInText(sourceTitle)[0];
        if (fromTitle) {
            return fromTitle;
        }
    }
    const target = extractTargetMachineIdForPanelCopy(text);
    if (target && ids.length >= 2) {
        const other = ids.find((id) => id !== target);
        if (other) {
            return other;
        }
    }
    if (uids.length >= 2 && ids.length >= 1) {
        return ids.find((id) => id !== target) ?? ids[0];
    }
    return undefined;
}

export function extractTargetMachineIdForPanelCopy(message: string): string | undefined {
    const text = normalizeMessageQuotes(message.trim());
    const panelOnTarget = text.match(
        new RegExp(
            `\\b(?:new|add|create)\\s+(?:a\\s+)?panel\\s+on\\s+(?:the\\s+)?(${MACHINE_ID_PATTERN.source})`,
            'i'
        )
    );
    if (panelOnTarget?.[1] && isMachineId(panelOnTarget[1])) {
        return panelOnTarget[1];
    }
    const targetTitle = extractTargetDashboardTitleForPanelCopy(text);
    if (targetTitle) {
        const fromTitle = findMachineIdsInText(targetTitle)[0];
        if (fromTitle) {
            return fromTitle;
        }
    }
    const dataFor = extractTargetMachineId(text);
    if (dataFor && isMachineId(dataFor)) {
        return dataFor;
    }
    const onTarget = text.match(
        new RegExp(`\\b(?:on|to|onto)\\s+(?:the\\s+)?(${MACHINE_ID_PATTERN.source})\\s+dashboard`, 'i')
    );
    if (onTarget?.[1] && isMachineId(onTarget[1])) {
        return onTarget[1];
    }
    const ids = findMachineIdsInText(text);
    if (ids.length === 1) {
        return ids[0];
    }
    if (ids.length >= 2 && dataFor) {
        return dataFor;
    }
    return undefined;
}

export function messageMentionsSinglePanelCopyIntent(message: string): boolean {
    const text = normalizeMessageQuotes(message.trim());
    if (!text || messageMentionsPeerBandPanelCopyIntent(text)) {
        return false;
    }
    if (isExplicitSinglePanelCopyRequest(text)) {
        return true;
    }
    if (describesDashboardCloneLayoutIntent(text)) {
        return false;
    }
    if (!/\bpanel/i.test(text)) {
        return false;
    }

    const hasCrossDashboardSignal =
        findMachineIdsInText(text).length >= 2 ||
        extractAllDashboardUids(text).length >= 2 ||
        (/\bfrom\b/i.test(text) && /\b(?:to|onto|on)\b/i.test(text));

    const describesCopy =
        /\bsame as\b/i.test(text) ||
        (/\b(copy|add|create|duplicate)\b/i.test(text) && /\bpanel/i.test(text));

    return hasCrossDashboardSignal && describesCopy;
}

export function diagnoseSinglePanelCopyGaps(message: string): string[] {
    const gaps: string[] = [];
    if (!messageMentionsSinglePanelCopyIntent(message)) {
        return gaps;
    }
    if (!extractPanelTitleFromCopyMessage(message)) {
        gaps.push('**Panel title** — quote the panel name, e.g. `"Pressure"`.');
    }
    const uids = extractAllDashboardUids(message);
    if (uids.length < 2 && findMachineIdsInText(message).length < 2) {
        gaps.push('**Source and target** — name both machine ids or both dashboard uids.');
    }
    if (!extractSourceMachineIdForPanelCopy(message) && !uids[0]) {
        gaps.push('**Source dashboard** — machine id or uid for the panel you are copying from.');
    }
    if (!extractTargetMachineIdForPanelCopy(message) && !uids[1]) {
        gaps.push('**Target dashboard** — machine id or uid where the new panel should be saved.');
    }
    return gaps;
}

export function formatSinglePanelCopyExamplePrompt(
    panelTitle = 'Pressure',
    sourceMachine = '2210-177097',
    targetMachine = '2505-200033'
): string {
    return (
        `Create a new panel on the ${targetMachine} dashboard that is the same as the "${panelTitle}" ` +
        `panel on ${sourceMachine} but with data for ${targetMachine}.`
    );
}

export const SINGLE_PANEL_COPY_EXAMPLE_PROMPT = formatSinglePanelCopyExamplePrompt();

export function parseSinglePanelCopyRequest(message: string): SinglePanelCopyRequest | null {
    const text = normalizeMessageQuotes(message.trim());
    if (!messageMentionsSinglePanelCopyIntent(text)) {
        return null;
    }

    const panelTitle = extractPanelTitleFromCopyMessage(text);
    if (!panelTitle) {
        return null;
    }

    const uids = extractAllDashboardUids(text);
    const replaceExisting = !/\b(?:do not replace|without replacing|keep existing)\b/i.test(text);
    const sourceMachineId = extractSourceMachineIdForPanelCopy(text);
    const targetMachineId = extractTargetMachineIdForPanelCopy(text);
    const sourceDashboardTitle = extractSourceDashboardTitleForPanelCopy(text);
    const targetDashboardTitle = extractTargetDashboardTitleForPanelCopy(text);
    const sourceDashboardUid = uids[0];
    const targetDashboardUid = uids.length >= 2 ? uids[1] : undefined;

    if (!sourceDashboardUid && !sourceMachineId && !sourceDashboardTitle) {
        return null;
    }
    if (!targetDashboardUid && !targetMachineId && !targetDashboardTitle) {
        return null;
    }

    return {
        panelTitle,
        sourceDashboardUid,
        targetDashboardUid,
        sourceDashboardTitle,
        targetDashboardTitle,
        sourceMachineId,
        targetMachineId,
        replaceExisting,
    };
}

export function userWantsSinglePanelCopy(message: string): boolean {
    return parseSinglePanelCopyRequest(message) != null;
}

export function formatSinglePanelCopyClarification(message?: string): string {
    const gaps = message ? diagnoseSinglePanelCopyGaps(message) : [];
    const gapBlock =
        gaps.length > 0 ? `\n\n**Still needed:**\n${gaps.map((g) => `- ${g}`).join('\n')}` : '';
    return (
        `### Need clarification — copy **one** panel to another dashboard\n\n` +
        `This copies a **single** panel, not the whole dashboard (no "36 of 41 panels"). ` +
        `Say which **panel title** to copy, the **source** dashboard, and the **target** dashboard.` +
        `${gapBlock}\n\n` +
        `**Example:** \`${SINGLE_PANEL_COPY_EXAMPLE_PROMPT}\``
    );
}
