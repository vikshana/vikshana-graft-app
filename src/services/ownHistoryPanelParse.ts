import { extractAllDashboardUids, extractDashboardUidFromMessage } from './dashboardMentionParse';
import { extractRequestedDashboardTitle, findMachineIdsInText } from './dashboardCloneParse';
import { extractOnDashboardMachineTitle } from './modulePanelReorderParse';
import { canonicalOwnHistoryTitle } from './modulePanelTitles';

export interface AddOwnHistoryPanelRequest {
    dashboardUid?: string;
    dashboardTitle?: string;
    machineId?: string;
    /** Set when the target is a module current ("Module 3 Current"). */
    moduleNumber?: number;
    /** Set when the target is a non-module signal (e.g. "Pressure"); resolved against the dashboard. */
    metricLabel?: string;
    /** Explicit quoted/titled panel name from the prompt (overrides canonical title). */
    panelTitle?: string;
}

export interface BulkOwnHistoryPanelCopyRequest {
    dashboardUid?: string;
    dashboardTitle?: string;
    templateModule: number;
    targetModules: number[];
}

function normalizeMessageQuotes(text: string): string {
    return text.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
}

export function messageMentionsOwnHistoryPanel(message: string): boolean {
    const text = normalizeMessageQuotes(message.trim());
    if (!text) {
        return false;
    }
    if (/\brandomforest\s+vs\s+peers\b/i.test(text) || /\bpeer\s*rf\b/i.test(text)) {
        return false;
    }
    if (/\bvs\.?\s*peer\s*band\b/i.test(text) && !/\bown\s+history\b/i.test(text)) {
        return false;
    }
    const hasTwoSigma =
        /\b2\s*σ\b/i.test(text) ||
        /\b±\s*2\s*σ\b/i.test(text) ||
        /\b2\s*sigma\b/i.test(text) ||
        /\b2\s*[×x*]\s*standard\s+dev/i.test(text) ||
        /\bstd(?:ard)?\s*dev(?:iation)?\b/i.test(text);
    return (
        /\bown\s+history\b/i.test(text) ||
        (/\bvs\.?\s*own\b/i.test(text) && hasTwoSigma) ||
        (/\bhistorical\s+mean\b/i.test(text) && hasTwoSigma && !/\bpeer\b/i.test(text)) ||
        (/\bstatistical\b/i.test(text) && hasTwoSigma && !/\bpeer\b/i.test(text)) ||
        (/\bupper\s+bound\b/i.test(text) &&
            /\blower\s+bound\b/i.test(text) &&
            hasTwoSigma &&
            !/\bpeer\b/i.test(text) &&
            !/\brandomforest\b/i.test(text))
    );
}

/** Quoted / titled panel name from create prompts (smart quotes already normalized). */
export function extractOwnHistoryPanelTitle(message: string): string | undefined {
    const text = normalizeMessageQuotes(message.trim());
    const patterns = [
        /\b(?:titled|called|named)\s+"([^"]+)"/i,
        /\b(?:titled|called|named)\s+'([^']+)'/i,
        /\bpanel\s+(?:titled|called|named)\s+"([^"]+)"/i,
        /\bpanel\s+(?:titled|called|named)\s+'([^']+)'/i,
    ];
    for (const re of patterns) {
        const m = text.match(re);
        if (m?.[1]?.trim()) {
            return m[1].trim();
        }
    }
    return undefined;
}

/**
 * Pull the target signal phrase out of "...panel for <X> on/for the dashboard ...".
 * Returns the trimmed phrase ("Pressure", "Module 3 Current") or undefined.
 */
export function extractOwnHistoryMetricLabel(message: string): string | undefined {
    const text = normalizeMessageQuotes(message.trim());
    const stop = '(?=\\s+(?:on|for|in)\\s+(?:the\\s+)?dashboard\\b|\\s+with\\s+uid\\b|\\s+uid\\b|[,.;]|$)';
    const m =
        text.match(new RegExp(`\\bpanel\\s+for\\s+(.+?)${stop}`, 'i')) ??
        text.match(new RegExp(`\\bfor\\s+(.+?)${stop}`, 'i'));
    if (!m?.[1]) {
        return undefined;
    }
    const label = m[1].replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').trim();
    if (!label || label.length > 48 || /[=]|uid|dashboard/i.test(label)) {
        return undefined;
    }
    return label;
}

export function parseAddOwnHistoryPanelRequest(message: string): AddOwnHistoryPanelRequest | null {
    const text = normalizeMessageQuotes(message.trim());
    if (!messageMentionsOwnHistoryPanel(text)) {
        return null;
    }
    if (!/\b(add|create|new)\b/i.test(text)) {
        return null;
    }
    if (/\bcopy\b/i.test(text) && /\bmodules?\s+(1|2|3|4|6|7|8)\b/i.test(text)) {
        return null;
    }
    const uids = extractAllDashboardUids(text);
    const machines = findMachineIdsInText(text);
    const machineId = machines[0];
    const dashboardTitle = extractRequestedDashboardTitle(text, machineId) ?? extractOnDashboardMachineTitle(text);
    const dashboardUid = uids[0] ?? extractDashboardUidFromMessage(text);

    let moduleNumber: number | undefined;
    let metricLabel: string | undefined;
    const phrase = extractOwnHistoryMetricLabel(text);
    if (phrase) {
        const mm = phrase.match(/\bmodule\s*(\d+)\b/i);
        if (mm?.[1]) {
            const n = parseInt(mm[1], 10);
            if (Number.isFinite(n) && n >= 1 && n <= 8) {
                moduleNumber = n;
            }
        } else {
            metricLabel = phrase;
        }
    }
    if (moduleNumber == null && metricLabel == null) {
        // No explicit target phrase — fall back to a bare "module N", else legacy default (5).
        const modMatch = text.match(/\bmodule\s*(\d+)\b/i);
        if (modMatch?.[1]) {
            const n = parseInt(modMatch[1], 10);
            if (Number.isFinite(n) && n >= 1 && n <= 8) {
                moduleNumber = n;
            }
        }
        if (moduleNumber == null) {
            moduleNumber = 5;
        }
    }
    // Prefer module number embedded in an explicit panel title (e.g. "Module 1 Current — …").
    const panelTitle = extractOwnHistoryPanelTitle(text);
    if (panelTitle) {
        const titleMod = panelTitle.match(/\bmodule\s*(\d+)\b/i);
        if (titleMod?.[1]) {
            const n = parseInt(titleMod[1], 10);
            if (Number.isFinite(n) && n >= 1 && n <= 8) {
                moduleNumber = n;
                metricLabel = undefined;
            }
        }
    }
    if (!dashboardUid && !dashboardTitle && !machineId) {
        return null;
    }
    return { dashboardUid, dashboardTitle, machineId, moduleNumber, metricLabel, panelTitle };
}

export function userWantsBulkOwnHistoryPanelCopy(message: string): boolean {
    const text = normalizeMessageQuotes(message.trim());
    if (!messageMentionsOwnHistoryPanel(text)) {
        return false;
    }
    return (
        (/\b(copy|match|duplicate)\b/i.test(text) || /\bother\s+modules?\b/i.test(text)) &&
        /\bmodule\b/i.test(text) &&
        (/\bmodules?\s+(1|2|3|4|6|7|8)\b/i.test(text) ||
            /\b1,\s*2,\s*3/i.test(text) ||
            /\ball\s+modules?\b/i.test(text))
    );
}

export function parseBulkOwnHistoryPanelCopyRequest(message: string): BulkOwnHistoryPanelCopyRequest | null {
    const text = normalizeMessageQuotes(message.trim());
    if (!userWantsBulkOwnHistoryPanelCopy(text)) {
        return null;
    }
    const uids = extractAllDashboardUids(text);
    const machines = findMachineIdsInText(text);
    const dashboardUid = uids[0] ?? extractDashboardUidFromMessage(text);
    const dashboardTitle = extractOnDashboardMachineTitle(text);
    let templateModule = 5;
    const templateMatch = text.match(/\b(?:from|match|like)\s+module\s*(\d+)\b/i);
    if (templateMatch?.[1]) {
        const n = parseInt(templateMatch[1], 10);
        if (Number.isFinite(n)) {
            templateModule = n;
        }
    }
    let targetModules = [1, 2, 3, 4, 6, 7, 8];
    const explicit = [...text.matchAll(/\bmodule\s*(\d+)\b/gi)]
        .map((m) => parseInt(m[1], 10))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= 8 && n !== templateModule);
    if (explicit.length >= 2) {
        targetModules = [...new Set(explicit)].sort((a, b) => a - b);
    }
    if (!dashboardUid && !dashboardTitle && !machines[0]) {
        return null;
    }
    return { dashboardUid, dashboardTitle, templateModule, targetModules };
}

export function userWantsOwnHistoryCanonicalNaming(message: string): boolean {
    const text = normalizeMessageQuotes(message.trim());
    if (!messageMentionsOwnHistoryPanel(text) || /\b(add|create|new|copy)\b/i.test(text)) {
        return false;
    }
    return (
        (/\bcanonical\b/i.test(text) ||
            /\bsuggested\s+nam/i.test(text) ||
            /\brename\b/i.test(text) ||
            /\buse\s+(the\s+)?suggested\s+title/i.test(text)) &&
        /\bmodule\b/i.test(text)
    );
}

export function parseOwnHistoryNamingRequest(
    message: string
): { dashboardUid?: string; dashboardTitle?: string } | null {
    const text = normalizeMessageQuotes(message.trim());
    if (!userWantsOwnHistoryCanonicalNaming(text)) {
        return null;
    }
    const uids = extractAllDashboardUids(text);
    const machines = findMachineIdsInText(text);
    const dashboardUid = uids[0] ?? extractDashboardUidFromMessage(text);
    const dashboardTitle = extractOnDashboardMachineTitle(text);
    if (!dashboardUid && !dashboardTitle && !machines[0]) {
        return null;
    }
    return { dashboardUid, dashboardTitle };
}

export function formatAddOwnHistoryPanelExamplePrompt(moduleNumber = 5): string {
    return (
        `On dashboard "2406-176021 / Exsolve", add panel "${canonicalOwnHistoryTitle(moduleNumber)}": ` +
        `Module ${moduleNumber} actual vs its own historical mean ± 2σ (Influx Flux, NOT RandomForest, NOT peer modules). ` +
        `Four targets: Actual, Historical Mean, Upper Bound (±2σ), Lower Bound (±2σ). Save.`
    );
}
