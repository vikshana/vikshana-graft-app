import { extractAllDashboardUids, extractDashboardUidFromMessage } from './dashboardMentionParse';
import { extractOnDashboardMachineTitle } from './modulePanelReorderParse';
import { extractRequestedDashboardTitle, findMachineIdsInText } from './dashboardCloneParse';
import { messageDescribesPanelRename } from './panelRenameParse';

export interface DashboardTitleRowRequest {
    dashboardUid?: string;
    dashboardTitle?: string;
    titleLabel: string;
}

function normalizeMessageQuotes(text: string): string {
    return text.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
}

function extractTitleLabel(text: string): string | undefined {
    const quoted =
        text.match(/title\s+row\s+(?:of|to)\s+["']([^"']+)["']/i) ??
        text.match(/(?:heading|banner|title)\s+(?:of|to)\s+["']([^"']+)["']/i) ??
        text.match(/["']([^"']+)["']\s+at\s+the\s+top/i);
    if (quoted?.[1]) {
        return quoted[1].trim();
    }
    const bare = text.match(/\btitle\s+row\s+(?:of|to)\s+([A-Za-z][A-Za-z0-9 _-]{1,40})\b/i);
    return bare?.[1]?.trim();
}

function wantsTitleRowAction(text: string): boolean {
    if (/\btitle\s+row\b/i.test(text)) {
        return true;
    }
    const hasTitleWord = /\b(title|heading|banner)\b/i.test(text);
    const hasPlacement = /\b(top|header)\b/i.test(text);
    if (!hasTitleWord || !hasPlacement) {
        return false;
    }
    return (
        /\b(add|create|insert|change|update|rename|set|replace)\b/i.test(text) ||
        /\bchange\b/i.test(text)
    );
}

export function userWantsDashboardTitleRow(message: string): boolean {
    const text = normalizeMessageQuotes(message.trim());
    if (!text || messageDescribesPanelRename(text)) {
        return false;
    }
    const wantsTitle = wantsTitleRowAction(text);
    if (!wantsTitle) {
        return false;
    }
    return Boolean(extractTitleLabel(text));
}

export function parseDashboardTitleRowRequest(message: string): DashboardTitleRowRequest | null {
    const text = normalizeMessageQuotes(message.trim());
    if (messageDescribesPanelRename(text)) {
        return null;
    }
    const titleLabel = extractTitleLabel(text);
    if (!titleLabel) {
        return null;
    }
    if (!wantsTitleRowAction(text)) {
        return null;
    }

    const uids = extractAllDashboardUids(text);
    const machines = findMachineIdsInText(text);
    const machineId = machines[0];
    const dashboardUid = uids[0] ?? extractDashboardUidFromMessage(text);
    const dashboardTitle =
        extractOnDashboardMachineTitle(text) ?? extractRequestedDashboardTitle(text, machineId);

    if (!dashboardUid && !dashboardTitle) {
        return null;
    }

    return { dashboardUid, dashboardTitle, titleLabel };
}

export function formatDashboardTitleRowExamplePrompt(
    dashboardUid = 'cfo0wckufbdhce',
    titleLabel = 'Keysight'
): string {
    return (
        `Add a title row of "${titleLabel}" at the top of the Grafana dashboard with UID = ${dashboardUid}. ` +
        `Use a full-width text panel at y=0 and shift all other panels down.`
    );
}
