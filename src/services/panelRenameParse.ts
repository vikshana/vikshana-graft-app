import { findMachineIdsInText, isMachineId, MACHINE_ID_PATTERN } from './dashboardCloneParse';
import { extractAllDashboardUids } from './dashboardMentionParse';

export interface PanelRenameRequest {
    currentPanelTitle: string;
    newPanelTitle: string;
    dashboardUid?: string;
    machineId?: string;
}

function normalizeMessageQuotes(text: string): string {
    return text.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
}

function extractCurrentPanelTitle(text: string): string | undefined {
    const patterns = [
        /\bchange\s+(?:the\s+)?name\s+of\s+(?:the\s+)?"([^"]+)"\s+panel/i,
        /\bchange\s+(?:the\s+)?name\s+of\s+(?:the\s+)?'([^']+)'\s+panel/i,
        /\bchange\s+(?:the\s+)?name\s+of\s+(?:the\s+)?([A-Za-z][A-Za-z0-9_ -]{1,80}?)\s+panel\b/i,
        /\brename\s+(?:the\s+)?"([^"]+)"\s+panel/i,
        /\brename\s+(?:the\s+)?'([^']+)'\s+panel/i,
        /\brename\s+(?:the\s+)?panel(?:\s+titled|\s+named|\s+called)?\s+"([^"]+)"/i,
        /\brename\s+(?:the\s+)?panel(?:\s+titled|\s+named|\s+called)?\s+'([^']+)'/i,
        /\brename\s+(?:the\s+)?([A-Za-z][A-Za-z0-9_ -]{1,80}?)\s+panel\b/i,
    ];
    for (const re of patterns) {
        const match = text.match(re);
        if (match?.[1]?.trim()) {
            return match[1].trim();
        }
    }
    return undefined;
}

function extractNewPanelTitle(text: string): string | undefined {
    const patterns = [
        /\bpanel\s+to\s+"([^"]+)"/i,
        /\bpanel\s+to\s+'([^']+)'/i,
        /\bpanel\s+to\s+be\s+"([^"]+)"/i,
        /\bpanel\s+to\s+be\s+'([^']+)'/i,
        // Unclosed quote / trailing period: to be "NewCurrent.
        /\bto\s+be\s+"([^"\n]+?)(?:[".]|\s*$)/i,
        /\bto\s+"([^"\n]+?)(?:[".]|\s*$)/i,
        /\bpanel\s+to\s+be\s+([A-Za-z][A-Za-z0-9_ -]+?)(?:\s+on\s+|\s*$|\.)/i,
        /\bpanel\s+to\s+([A-Za-z][A-Za-z0-9_ -]+?)(?:\s+on\s+(?:the\s+)?dashboard|\s*$|\.)/i,
        /\bto\s+be\s+([A-Za-z][A-Za-z0-9_ -]+?)(?:\s+on\s+|\s*$|\.)/i,
        /\bto\s+"([^"]+)"/i,
        /\bto\s+'([^']+)'/i,
    ];
    for (const re of patterns) {
        const match = text.match(re);
        if (match?.[1]?.trim()) {
            return match[1].trim().replace(/[."']+$/g, '');
        }
    }
    return undefined;
}

function extractMachineIdForPanelRename(message: string): string | undefined {
    const text = normalizeMessageQuotes(message.trim());
    const forMachine = text.match(
        new RegExp(`\\bfor\\s+(?:the\\s+)?(?:machine\\s+)?(${MACHINE_ID_PATTERN.source})\\b`, 'i')
    );
    if (forMachine?.[1] && isMachineId(forMachine[1])) {
        return forMachine[1];
    }
    const ids = findMachineIdsInText(text);
    return ids.find((id) => isMachineId(id));
}

/** User wants to rename a panel title, not the dashboard title. */
export function messageDescribesPanelRename(message: string): boolean {
    const text = normalizeMessageQuotes(message.trim());
    const renameVerb =
        /\brename\b/i.test(text) || /\bchange\s+(?:the\s+)?name\b/i.test(text);
    if (!renameVerb || !/\bpanel\b/i.test(text)) {
        return false;
    }
    if (/\brename\s+(?:the\s+)?dashboard\b/i.test(text) && !extractCurrentPanelTitle(text)) {
        return false;
    }
    return Boolean(extractCurrentPanelTitle(text) || /\b(?:rename|change\s+(?:the\s+)?name)\s+(?:the\s+)?panel\b/i.test(text));
}

export function parsePanelRenameRequest(message: string): PanelRenameRequest | null {
    const text = normalizeMessageQuotes(message.trim());
    if (!messageDescribesPanelRename(text)) {
        return null;
    }

    const currentPanelTitle = extractCurrentPanelTitle(text);
    const newPanelTitle = extractNewPanelTitle(text);
    if (!currentPanelTitle?.trim() || !newPanelTitle?.trim()) {
        return null;
    }

    const dashboardUid = extractAllDashboardUids(text)[0];
    const machineId = extractMachineIdForPanelRename(text);
    if (!dashboardUid && !machineId) {
        return null;
    }

    return {
        currentPanelTitle: currentPanelTitle.trim(),
        newPanelTitle: newPanelTitle.trim(),
        dashboardUid,
        machineId,
    };
}

export function userWantsPanelRename(message: string): boolean {
    return parsePanelRenameRequest(message) != null;
}

export function diagnosePanelRenameGaps(message: string): string[] {
    const text = normalizeMessageQuotes(message.trim());
    const gaps: string[] = [];
    if (!messageDescribesPanelRename(text)) {
        return gaps;
    }
    if (!extractCurrentPanelTitle(text)) {
        gaps.push('**Current panel title** (e.g. `"Pressure Gauge"`)');
    }
    if (!extractNewPanelTitle(text)) {
        gaps.push('**New panel title** (e.g. `to "System Pressure"`)');
    }
    if (!extractAllDashboardUids(text)[0] && !extractMachineIdForPanelRename(text)) {
        gaps.push('**Dashboard uid** or **machine id**');
    }
    return gaps;
}

export function formatPanelRenameClarification(message?: string): string {
    const gaps = message ? diagnosePanelRenameGaps(message) : [];
    const gapBlock =
        gaps.length > 0
            ? `\n\nGraft still needs:\n${gaps.map((g) => `- ${g}`).join('\n')}\n`
            : '\n\nInclude the **panel title**, **new title**, and **dashboard uid** (or machine id).\n';

    return (
        `### Need clarification\n\n` +
        `To rename a panel title, say which panel and the new title — the dashboard title stays unchanged.${gapBlock}` +
        `**Example:** \`Rename the "Pressure Gauge" panel to "System Pressure" on dashboard uid=cfo0wckufbdhce\``
    );
}

export function formatPanelRenameNotFoundClarification(
    request: PanelRenameRequest,
    opts?: { dashboardTitle?: string; panelTitles?: string[] }
): string {
    const nearby =
        opts?.panelTitles?.length &&
        `\n\nPanels on this dashboard:\n${opts.panelTitles.slice(0, 12).map((t) => `- ${t}`).join('\n')}`;

    return (
        `### Need clarification\n\n` +
        `Graft understood: rename panel **${request.currentPanelTitle}** → **${request.newPanelTitle}**` +
        (request.dashboardUid ? ` on dashboard uid \`${request.dashboardUid}\`` : '') +
        `, but **could not find a matching panel**.${nearby || ''}\n\n` +
        `Check the panel title spelling or reply with **panel id** / **array index**.`
    );
}
