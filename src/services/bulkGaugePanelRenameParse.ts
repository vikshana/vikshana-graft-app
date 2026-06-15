import { extractAllDashboardUids } from './dashboardMentionParse';
import { findMachineIdsInText, isMachineId, MACHINE_ID_PATTERN } from './dashboardCloneParse';
import { messageDescribesPanelRename } from './panelRenameParse';

export interface BulkGaugePanelRenameRequest {
    titlePrefix: string;
    dashboardUid?: string;
    machineId?: string;
}

function normalizeMessageQuotes(text: string): string {
    return text.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
}

function extractTitlePrefix(text: string): string | undefined {
    const patterns = [
        /\bto\s+(?:begin|start)\s+with\s+"([^"]+)"/i,
        /\bto\s+(?:begin|start)\s+with\s+'([^']+)'/i,
        /\b(?:begin|start)\s+with\s+"([^"]+)"/i,
        /\b(?:begin|start)\s+with\s+'([^']+)'/i,
        /\bprefix\s+"([^"]+)"/i,
        /\bprefix\s+'([^']+)'/i,
        /\bwith\s+the\s+prefix\s+"([^"]+)"/i,
    ];
    for (const re of patterns) {
        const match = text.match(re);
        if (match?.[1]?.trim()) {
            return match[1].trim();
        }
    }
    const bare = text.match(/\b(?:begin|start)\s+with\s+([A-Za-z][A-Za-z0-9_-]{0,30})\b/i);
    if (bare?.[1] && !/^(with|the|a)$/i.test(bare[1])) {
        return bare[1].trim();
    }
    return undefined;
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

export function messageDescribesBulkGaugePanelRename(message: string): boolean {
    const text = normalizeMessageQuotes(message.trim());
    if (!text || messageDescribesPanelRename(text)) {
        return false;
    }
    if (!/\brename\b/i.test(text)) {
        return false;
    }
    if (!/\b(all|every|each)\b/i.test(text)) {
        return false;
    }
    if (!/\bgauge\b/i.test(text) || !/\bpanel/i.test(text)) {
        return false;
    }
    return Boolean(extractTitlePrefix(text));
}

export function parseBulkGaugePanelRenameRequest(
    message: string,
    opts?: { contextDashboardUid?: string }
): BulkGaugePanelRenameRequest | null {
    const text = normalizeMessageQuotes(message.trim());
    if (!messageDescribesBulkGaugePanelRename(text)) {
        return null;
    }
    const titlePrefix = extractTitlePrefix(text);
    if (!titlePrefix) {
        return null;
    }
    const dashboardUid = extractAllDashboardUids(text)[0] ?? opts?.contextDashboardUid;
    const machineId = extractMachineId(text);
    if (!dashboardUid && !machineId) {
        return null;
    }
    return { titlePrefix, dashboardUid, machineId };
}

export function userWantsBulkGaugePanelRenameProgrammatic(
    message: string,
    contextDashboardUid?: string
): boolean {
    return parseBulkGaugePanelRenameRequest(message, { contextDashboardUid }) != null;
}

export function formatBulkGaugePanelRenameClarification(): string {
    return (
        `### Need clarification\n\n` +
        `To bulk-rename gauge panels, specify the title prefix and dashboard.\n\n` +
        `**Example:** \`Rename all gauge panels to begin with "System" for dashboard with UID = cfo0wckufbdhce.\``
    );
}
