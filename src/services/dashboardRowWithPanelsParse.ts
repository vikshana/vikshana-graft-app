import { extractAllDashboardUids } from './dashboardMentionParse';
import { findMachineIdsInText, isMachineId, MACHINE_ID_PATTERN } from './dashboardCloneParse';
import { messageDescribesPanelCreate } from './panelCreateParse';

export interface DashboardRowWithPanelsRequest {
    rowTitle: string;
    panelCount: number;
    dashboardUid?: string;
    machineId?: string;
}

function normalizeMessageQuotes(text: string): string {
    return text.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
}

function extractRowTitle(text: string): string | undefined {
    const patterns = [
        /\b(?:dashboard\s+)?row\s+called\s+"([^"]+)"/i,
        /\b(?:dashboard\s+)?row\s+called\s+'([^']+)'/i,
        /\b(?:dashboard\s+)?row\s+(?:named|titled)\s+"([^"]+)"/i,
        /\brow\s+"([^"]+)"/i,
    ];
    for (const re of patterns) {
        const match = text.match(re);
        if (match?.[1]?.trim()) {
            return match[1].trim();
        }
    }
    return undefined;
}

function extractPanelCount(text: string): number {
    const wordMap: Record<string, number> = {
        one: 1,
        two: 2,
        three: 3,
        four: 4,
        five: 5,
        six: 6,
    };
    const digit = text.match(/\b(\d{1,2})\s+panels?\b/i);
    if (digit?.[1]) {
        const n = parseInt(digit[1], 10);
        if (n > 0 && n <= 12) {
            return n;
        }
    }
    const word = text.match(/\b(one|two|three|four|five|six)\s+panels?\b/i);
    if (word?.[1]) {
        return wordMap[word[1].toLowerCase()] ?? 2;
    }
    if (/\badd\s+(?:two|2)\s+panels?\b/i.test(text) || /\btwo\s+panels?\b/i.test(text)) {
        return 2;
    }
    if (/\badd\s+panels?\b/i.test(text) || /\bpanel(s)?\s+to\s+it\b/i.test(text)) {
        return 2;
    }
    return 2;
}

function extractMachineId(text: string): string | undefined {
    const forMachine = text.match(
        new RegExp(`\\bfor\\s+(?:the\\s+)?(?:machine\\s+)?(${MACHINE_ID_PATTERN.source})\\b`, 'i')
    );
    if (forMachine?.[1] && isMachineId(forMachine[1])) {
        return forMachine[1];
    }
    return findMachineIdsInText(text).find((id) => isMachineId(id));
}

function hasDashboardContext(text: string, contextDashboardUid?: string): boolean {
    return Boolean(extractAllDashboardUids(text)[0] ?? contextDashboardUid ?? extractMachineId(text));
}

export function messageDescribesDashboardRowWithPanels(
    message: string,
    contextDashboardUid?: string
): boolean {
    const text = normalizeMessageQuotes(message.trim());
    if (!text || messageDescribesPanelCreate(text)) {
        return false;
    }
    if (!/\b(create|add|make)\b/i.test(text)) {
        return false;
    }
    if (!/\b(?:dashboard\s+)?row\b/i.test(text)) {
        return false;
    }
    if (!extractRowTitle(text)) {
        return false;
    }
    if (!/\bpanel/i.test(text)) {
        return false;
    }
    return hasDashboardContext(text, contextDashboardUid);
}

export function parseDashboardRowWithPanelsRequest(
    message: string,
    opts?: { contextDashboardUid?: string }
): DashboardRowWithPanelsRequest | null {
    const text = normalizeMessageQuotes(message.trim());
    if (!messageDescribesDashboardRowWithPanels(text, opts?.contextDashboardUid)) {
        return null;
    }
    const rowTitle = extractRowTitle(text);
    if (!rowTitle) {
        return null;
    }
    const dashboardUid = extractAllDashboardUids(text)[0] ?? opts?.contextDashboardUid;
    const machineId = extractMachineId(text);
    if (!dashboardUid && !machineId) {
        return null;
    }
    return {
        rowTitle,
        panelCount: extractPanelCount(text),
        dashboardUid,
        machineId,
    };
}

export function userWantsDashboardRowWithPanelsProgrammatic(
    message: string,
    contextDashboardUid?: string
): boolean {
    return parseDashboardRowWithPanelsRequest(message, { contextDashboardUid }) != null;
}

export function formatDashboardRowWithPanelsClarification(): string {
    return (
        `### Need clarification\n\n` +
        `Graft understood a row-with-panels request but needs the dashboard.\n\n` +
        `**Example:** \`Create a dashboard row called "Machine Health" and add two panels to it for dashboard with UID = cfo0wckufbdhce.\``
    );
}
