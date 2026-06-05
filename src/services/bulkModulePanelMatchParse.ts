import { extractAllDashboardUids, extractDashboardUidFromMessage } from './dashboardMentionParse';
import { findMachineIdsInText } from './dashboardCloneParse';
import { extractOnDashboardMachineTitle } from './modulePanelReorderParse';

export interface BulkModulePanelMatchRequest {
    dashboardUid?: string;
    dashboardTitle?: string;
    templateModule: number;
    targetModules: number[];
}

function normalizeMessageQuotes(text: string): string {
    return text.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
}

export function userWantsBulkModulePanelMatch(message: string): boolean {
    const text = normalizeMessageQuotes(message.trim());
    if (!text) {
        return false;
    }
    const mentionsTemplate =
        /\bmodule\s*5\b/i.test(text) ||
        /\bmatch(es)?\s+module\s*5\b/i.test(text) ||
        /\blike\s+module\s*5\b/i.test(text);
    if (!mentionsTemplate) {
        return false;
    }
    const wantsAddOrMatch =
        /\bmatch(es)?\b/i.test(text) ||
        /\badd\b/i.test(text) ||
        /\bcopy\b/i.test(text) ||
        /\bmissing\b/i.test(text) ||
        /\btwo\b/i.test(text) ||
        /\bsame\s+(four|4)\b/i.test(text);
    const mentionsOtherModules =
        /\bother\s+modules?\b/i.test(text) ||
        /\bmodules?\s+(1|2|3|4|6|7|8)\b/i.test(text) ||
        /\b1,\s*2,\s*3,\s*4,\s*6/i.test(text) ||
        (/\bfor\s+modules?\b/i.test(text) && /\b1\b/.test(text));
    return wantsAddOrMatch && mentionsOtherModules && /\bmodule\b/i.test(text) && /\bcurrent\b/i.test(text);
}

export function parseBulkModulePanelMatchRequest(message: string): BulkModulePanelMatchRequest | null {
    const text = normalizeMessageQuotes(message.trim());
    if (!userWantsBulkModulePanelMatch(text)) {
        return null;
    }

    const uids = extractAllDashboardUids(text);
    const machines = findMachineIdsInText(text);
    const dashboardUid = uids[0] ?? extractDashboardUidFromMessage(text);
    const dashboardTitle = extractOnDashboardMachineTitle(text);

    let targetModules = [1, 2, 3, 4, 6, 7, 8];
    const explicit = [...text.matchAll(/\bmodule\s*(\d+)\b/gi)]
        .map((m) => parseInt(m[1], 10))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= 8 && n !== 5);
    if (explicit.length >= 2) {
        targetModules = [...new Set(explicit)].sort((a, b) => a - b);
    }

    if (!dashboardUid && !dashboardTitle && !machines[0]) {
        return null;
    }

    return {
        dashboardUid,
        dashboardTitle,
        templateModule: 5,
        targetModules,
    };
}

export function formatBulkModulePanelMatchExamplePrompt(
    dashboardTitle = '2406-176021 / Exsolve'
): string {
    return (
        `On dashboard "${dashboardTitle}": Module 5 Current has four panels (History Comparison, ` +
        `History Comparison historical/Influx, vs. Peer Band, RandomForest vs Peers). ` +
        `Add the two missing Influx panels to Modules 1,2,3,4,6,7,8 to match Module 5 naming, then reorder Module N Current 1→8.`
    );
}
