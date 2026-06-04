import { extractRequestedDashboardTitle, findMachineIdsInText, isMachineId } from './dashboardCloneParse';
import { extractAllDashboardUids } from './dashboardMentionParse';
import { extractPanelTitleFromCopyMessage } from './singlePanelCopyParse';

export interface PanelJsonDuplicateRequest {
    dashboardTitle?: string;
    dashboardUid?: string;
    machineId?: string;
    sourcePanelTitle: string;
    panelJson: Record<string, unknown>;
}

function normalizeMessageQuotes(text: string): string {
    return text.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
}

/** Extract a Grafana panel object embedded in the user message. */
export function extractPanelJsonFromMessage(message: string): Record<string, unknown> | undefined {
    const text = normalizeMessageQuotes(message);
    const markers = [
        /\bwith this json\s*/i,
        /\breplace the json\b[\s\S]*?\bwith\s*/i,
        /\bpanel json\s*/i,
    ];
    let start = -1;
    for (const re of markers) {
        const m = text.match(re);
        if (m?.index != null) {
            const brace = text.indexOf('{', m.index + m[0].length);
            if (brace >= 0) {
                start = brace;
                break;
            }
        }
    }
    if (start < 0) {
        start = text.indexOf('{\n  "id"');
        if (start < 0) {
            start = text.indexOf('{"id"');
        }
        if (start < 0) {
            start = text.indexOf('{');
        }
    }
    if (start < 0) {
        return undefined;
    }

    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escape) {
                escape = false;
            } else if (ch === '\\') {
                escape = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }
        if (ch === '"') {
            inString = true;
            continue;
        }
        if (ch === '{') {
            depth++;
        } else if (ch === '}') {
            depth--;
            if (depth === 0) {
                const slice = text.slice(start, i + 1);
                try {
                    const parsed = JSON.parse(slice) as Record<string, unknown>;
                    if (parsed && typeof parsed === 'object' && (parsed.type || parsed.targets)) {
                        return parsed;
                    }
                } catch {
                    return undefined;
                }
            }
        }
    }
    return undefined;
}

export function messageMentionsPanelJsonDuplicateIntent(message: string): boolean {
    const text = normalizeMessageQuotes(message.trim());
    if (!text || !/\bpanel/i.test(text)) {
        return false;
    }
    const hasJson = Boolean(extractPanelJsonFromMessage(text));
    const duplicate =
        /\b(duplicate|copy)\b/i.test(text) &&
        /\b(panel|visualization)\b/i.test(text);
    const replaceJson =
        /\breplace\b/i.test(text) && /\bjson\b/i.test(text) && hasJson;
    const sameDashboard =
        /\bdashboard\s+named\b/i.test(text) ||
        findMachineIdsInText(text).length <= 1 ||
        extractAllDashboardUids(text).length <= 1;

    return sameDashboard && hasJson && (duplicate || replaceJson);
}

export function parsePanelJsonDuplicateRequest(message: string): PanelJsonDuplicateRequest | null {
    const text = normalizeMessageQuotes(message.trim());
    if (!messageMentionsPanelJsonDuplicateIntent(text)) {
        return null;
    }

    const panelJson = extractPanelJsonFromMessage(text);
    if (!panelJson) {
        return null;
    }

    const sourcePanelTitle = extractPanelTitleFromCopyMessage(text);
    if (!sourcePanelTitle) {
        return null;
    }

    const uids = extractAllDashboardUids(text);
    const machines = findMachineIdsInText(text);
    const machineId = machines[0];
    const dashboardTitle = extractRequestedDashboardTitle(text, machineId);

    if (!dashboardTitle && !uids[0] && !machineId) {
        return null;
    }

    return {
        dashboardTitle,
        dashboardUid: uids[0],
        machineId: machineId && isMachineId(machineId) ? machineId : undefined,
        sourcePanelTitle,
        panelJson,
    };
}

export function formatPanelJsonDuplicateClarification(): string {
    return (
        '### Need clarification — duplicate panel and paste JSON\n\n' +
        'Example:\n\n' +
        'In dashboard named **"2406-176021 / Exsolve"**, duplicate the panel **"Module 5 Current — History Comparison"**, ' +
        'replace the new panel JSON with the RandomForest panel object, and save.\n\n' +
        'Paste the full panel `{ ... }` after **with this json**.'
    );
}
