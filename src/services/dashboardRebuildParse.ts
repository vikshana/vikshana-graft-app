import { extractAllDashboardUids, extractDashboardUidFromMessage } from './dashboardMentionParse';
import { extractOnDashboardMachineTitle } from './modulePanelReorderParse';
import { extractRequestedDashboardTitle, findMachineIdsInText } from './dashboardCloneParse';

export interface DashboardRebuildRequest {
    dashboardUid?: string;
    dashboardTitle?: string;
    titleLabel?: string;
}

function normalizeMessageQuotes(text: string): string {
    return text.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
}

function mentionsPowerTechConventions(text: string): boolean {
    return /\b(powertech|power\s*tech)\b/i.test(text) && /\b(convention|standard|practice|best\s*practice)\b/i.test(text);
}

function mentionsRebuildOrReorganize(text: string): boolean {
    return (
        /\b(re-?\s*build|reorganiz|reorganis|from\s+scratch|clean\s+up|best\s*practices?)\b/i.test(text) ||
        (/\b(add|remove)\b/i.test(text) && mentionsPowerTechConventions(text))
    );
}

function extractInstrumentationLabel(text: string): string | undefined {
    const keysight = text.match(/\bkeysight\b/i);
    if (keysight) {
        return 'Keysight';
    }
    const quoted = text.match(/\b(?:machine|monitors?)\s+(?:named\s+)?["']?([A-Za-z][A-Za-z0-9 _-]{2,30})["']?/i);
    return quoted?.[1]?.trim();
}

export function userWantsDashboardRebuild(message: string): boolean {
    const text = normalizeMessageQuotes(message.trim());
    if (!text) {
        return false;
    }
    if (!mentionsRebuildOrReorganize(text) && !mentionsPowerTechConventions(text)) {
        return false;
    }
    if (!/\b(dashboard|dash\s*board|panels?|uid|keysight|machine)\b/i.test(text)) {
        return false;
    }
    return Boolean(extractDashboardUidFromMessage(text) || extractOnDashboardMachineTitle(text) || extractInstrumentationLabel(text));
}

export function parseDashboardRebuildRequest(message: string): DashboardRebuildRequest | null {
    const text = normalizeMessageQuotes(message.trim());
    if (!userWantsDashboardRebuild(text)) {
        return null;
    }

    const uids = extractAllDashboardUids(text);
    const machines = findMachineIdsInText(text);
    const machineId = machines[0];
    const dashboardUid = uids[0] ?? extractDashboardUidFromMessage(text);
    const dashboardTitle =
        extractOnDashboardMachineTitle(text) ?? extractRequestedDashboardTitle(text, machineId);
    const titleLabel = extractInstrumentationLabel(text);

    if (!dashboardUid && !dashboardTitle && !titleLabel) {
        return null;
    }

    return { dashboardUid, dashboardTitle, titleLabel };
}

export function formatDashboardRebuildExamplePrompt(
    dashboardUid = 'cfo0wckufbdhce',
    label = 'Keysight'
): string {
    return (
        `Reorganize dashboard uid ${dashboardUid} using PowerTech best practices for the ${label} machine. ` +
        `Keep existing panel queries; fix layout (title row, KPIs, trends). Do not add Module N Current panels on instrumentation dashboards.`
    );
}
