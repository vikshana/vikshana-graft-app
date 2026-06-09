import { findMachineIdsInText, isMachineId, MACHINE_ID_PATTERN } from './dashboardCloneParse';
import { extractAllDashboardUids } from './dashboardMentionParse';

export interface PanelRemoveRequest {
    panelTitle: string;
    dashboardUid?: string;
    machineId?: string;
}

function normalizeMessageQuotes(text: string): string {
    return text.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
}

function extractPanelTitleToRemove(text: string): string | undefined {
    const patterns = [
        /\b(?:remove|delete)\s+(?:the\s+)?"([^"]+)"\s+panel/i,
        /\b(?:remove|delete)\s+(?:the\s+)?'([^']+)'\s+panel/i,
        /\b(?:remove|delete)\s+(?:the\s+)?panel(?:\s+titled|\s+named|\s+called)?\s+"([^"]+)"/i,
        /\b(?:remove|delete)\s+(?:the\s+)?panel(?:\s+titled|\s+named|\s+called)?\s+'([^']+)'/i,
        /\b(?:remove|delete)\s+(?:the\s+)?([A-Za-z][A-Za-z0-9_ -]{1,80}?)\s+panel\b/i,
        /\b(?:remove|delete)\s+(?:the\s+)?panel\s+"([^"]+)"/i,
        /\b(?:remove|delete)\s+(?:the\s+)?panel\s+'([^']+)'/i,
    ];
    for (const re of patterns) {
        const match = text.match(re);
        if (match?.[1]?.trim()) {
            return match[1].trim();
        }
    }
    return undefined;
}

function extractMachineId(message: string): string | undefined {
    const text = normalizeMessageQuotes(message.trim());
    const forMachine = text.match(
        new RegExp(`\\bfor\\s+(?:the\\s+)?(?:machine\\s+)?(${MACHINE_ID_PATTERN.source})\\b`, 'i')
    );
    if (forMachine?.[1] && isMachineId(forMachine[1])) {
        return forMachine[1];
    }
    return findMachineIdsInText(text).find((id) => isMachineId(id));
}

export function messageDescribesPanelRemove(message: string): boolean {
    const text = normalizeMessageQuotes(message.trim());
    if (!/\b(?:remove|delete)\b/i.test(text) || !/\bpanel\b/i.test(text)) {
        return false;
    }
    if (/\b(?:remove|delete)\s+(?:the\s+)?dashboard\b/i.test(text) && !extractPanelTitleToRemove(text)) {
        return false;
    }
    return Boolean(extractPanelTitleToRemove(text) || /\b(?:remove|delete)\s+(?:the\s+)?panel\b/i.test(text));
}

export function parsePanelRemoveRequest(
    message: string,
    opts?: { contextDashboardUid?: string }
): PanelRemoveRequest | null {
    const text = normalizeMessageQuotes(message.trim());
    if (!messageDescribesPanelRemove(text)) {
        return null;
    }

    const panelTitle = extractPanelTitleToRemove(text);
    if (!panelTitle?.trim()) {
        return null;
    }

    const dashboardUid = extractAllDashboardUids(text)[0] ?? opts?.contextDashboardUid;
    const machineId = extractMachineId(text);

    if (!dashboardUid && !machineId) {
        return null;
    }

    return {
        panelTitle: panelTitle.trim(),
        dashboardUid,
        machineId,
    };
}

export function userWantsPanelRemove(message: string, contextDashboardUid?: string): boolean {
    return parsePanelRemoveRequest(message, { contextDashboardUid }) != null;
}

export function formatPanelRemoveClarification(message?: string): string {
    return (
        `### Need clarification\n\n` +
        `To remove a panel, name the panel and the dashboard **uid** (or open the dashboard in Grafana so Graft has context).\n\n` +
        `**Example:** \`Remove the "Cartridge Happiness Score" panel on dashboard uid=cfo0wckufbdhce\``
    );
}

export function formatPanelRemoveNotFoundClarification(
    request: PanelRemoveRequest,
    opts?: { dashboardTitle?: string; panelTitles?: string[] }
): string {
    const nearby =
        opts?.panelTitles?.length &&
        `\n\nPanels on this dashboard:\n${opts.panelTitles.slice(0, 12).map((t) => `- ${t}`).join('\n')}`;

    return (
        `### Need clarification\n\n` +
        `Graft understood: remove panel **${request.panelTitle}**` +
        (request.dashboardUid ? ` on dashboard uid \`${request.dashboardUid}\`` : '') +
        `, but **could not find a matching panel**.${nearby || ''}\n\n` +
        `Check the panel title spelling or reply with **panel id** / **array index**.`
    );
}
