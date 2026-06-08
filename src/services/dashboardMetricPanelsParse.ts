import { extractAllDashboardUids, extractDashboardUidFromMessage } from './dashboardMentionParse';
import { extractOnDashboardMachineTitle } from './modulePanelReorderParse';
import { extractRequestedDashboardTitle, findMachineIdsInText } from './dashboardCloneParse';

export interface DashboardMetricPanelsRequest {
    dashboardUid?: string;
    dashboardTitle?: string;
    titleLabel?: string;
    machineId?: string;
    maxPanels?: number;
}

function normalizeMessageQuotes(text: string): string {
    return text.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
}

function extractPanelCount(text: string): number | undefined {
    const m = text.match(/\b(\d{1,3})\s+panels?\b/i);
    if (!m?.[1]) {
        return undefined;
    }
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

function extractInstrumentationLabel(text: string): string | undefined {
    if (/\bkeysight\b/i.test(text)) {
        return 'Keysight';
    }
    const quoted = text.match(/\b(?:machine|monitors?)\s+(?:named\s+)?["']?([A-Za-z][A-Za-z0-9 _-]{2,30})["']?/i);
    return quoted?.[1]?.trim();
}

export function userWantsDashboardMetricPanels(message: string): boolean {
    const text = normalizeMessageQuotes(message.trim());
    if (!text) {
        return false;
    }
    const bulkMetricIntent =
        /\b(every|all|each)\b/i.test(text) &&
        /\b(available|metric|metrics|field|fields|signal|signals)\b/i.test(text);
    const numberedBulk =
        /\b\d{1,3}\s+panels?\b/i.test(text) &&
        /\b(covering|cover|every|all|each|metric|metrics)\b/i.test(text);
    const createPanels =
        /\b(create|add|make|build)\b/i.test(text) && /\bpanel/i.test(text) && bulkMetricIntent;
    if (!createPanels && !numberedBulk) {
        return false;
    }
    return Boolean(
        extractDashboardUidFromMessage(text) ||
            extractOnDashboardMachineTitle(text) ||
            extractInstrumentationLabel(text) ||
            findMachineIdsInText(text).length > 0
    );
}

export function parseDashboardMetricPanelsRequest(message: string): DashboardMetricPanelsRequest | null {
    const text = normalizeMessageQuotes(message.trim());
    if (!userWantsDashboardMetricPanels(text)) {
        return null;
    }

    const uids = extractAllDashboardUids(text);
    const machines = findMachineIdsInText(text);
    const dashboardUid = uids[0] ?? extractDashboardUidFromMessage(text);
    const machineId = machines[0];
    const dashboardTitle =
        extractOnDashboardMachineTitle(text) ?? extractRequestedDashboardTitle(text, machineId);
    const titleLabel = extractInstrumentationLabel(text);
    const maxPanels = extractPanelCount(text) ?? 50;

    if (!dashboardUid && !dashboardTitle && !titleLabel && !machineId) {
        return null;
    }

    return { dashboardUid, dashboardTitle, titleLabel, machineId, maxPanels };
}

export function formatDashboardMetricPanelsExamplePrompt(
    dashboardUid = 'cfo0wckufbdhce',
    count = 50
): string {
    return (
        `Create ${count} panels covering every available metric on the dashboard with UID = ${dashboardUid}. ` +
        `Use Prometheus metrics for machine 2505-200033; do not invent Influx keysight_machine fields.`
    );
}
