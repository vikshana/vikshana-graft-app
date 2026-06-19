import { extractRequestedDashboardTitle, findMachineIdsInText } from './dashboardCloneParse';
import { extractAllDashboardUids, extractPanelIdFromMessage, extractPanelTitleFromMessage } from './dashboardMentionParse';

export interface InfluxPanelRepairRequest {
    dashboardUid?: string;
    dashboardTitle?: string;
    machineId?: string;
    panelTitle?: string;
    panelId?: number;
}

function normalizeMessageQuotes(text: string): string {
    return text.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
}

export function extractPanelTitleForRepair(message: string): string | undefined {
    const text = normalizeMessageQuotes(message.trim());
    const patterns = [
        /\bname\s+in\s+"([^"]+)"/i,
        /\bpanel\s+"([^"]+)"\s+fix/i,
        /\bfix(?:\s+the)?\s+panel\s+"([^"]+)"/i,
        /\b(?:named|titled)\s+"([^"]+)"/i,
    ];
    for (const re of patterns) {
        const m = text.match(re);
        if (m?.[1]?.trim()) {
            return m[1].trim().replace(/\.+$/, '');
        }
    }
    return extractPanelTitleFromMessage(text);
}

export function messageMentionsInfluxPanelRepair(message: string): boolean {
    const text = normalizeMessageQuotes(message.trim());
    if (!/\b(fix|repair|correct)\b/i.test(text) || !/\bpanel\b/i.test(text)) {
        return false;
    }
    const fluxError =
        /\bparse error\b/i.test(text) ||
        /\bunexpected identifier\b/i.test(text) ||
        /\bbad_data\b/i.test(text) ||
        /\bStatus:\s*400\b/i.test(text) ||
        /\bevaluating\s+['"]v['"]/i.test(text);
    const fluxPanel =
        /\bfrom\s*\(\s*bucket:/i.test(text) ||
        /\brandomforest\b/i.test(text) ||
        /\bml_predictions\b/i.test(text) ||
        /\bpanel json\b/i.test(text) ||
        /\brawQuery\b/i.test(text);
    return fluxError || (fluxPanel && /\b(json|flux|influx|expr|rawQuery|timeFrom|timeTo)\b/i.test(text));
}

export function parseInfluxPanelRepairRequest(message: string): InfluxPanelRepairRequest | null {
    const text = normalizeMessageQuotes(message.trim());
    if (!messageMentionsInfluxPanelRepair(text)) {
        return null;
    }

    const uids = extractAllDashboardUids(text);
    const machines = findMachineIdsInText(text);
    const machineId = machines[0];
    const dashboardTitle = extractRequestedDashboardTitle(text, machineId);
    const panelTitle = extractPanelTitleForRepair(text);
    const panelId = extractPanelIdFromMessage(text);

    if (!uids[0] && !dashboardTitle && !machineId) {
        return null;
    }
    if (!panelTitle && panelId == null) {
        return null;
    }

    return {
        dashboardUid: uids[0],
        dashboardTitle,
        machineId,
        panelTitle,
        panelId,
    };
}
