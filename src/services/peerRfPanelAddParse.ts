import { extractAllDashboardUids, extractDashboardUidFromMessage } from './dashboardMentionParse';
import { extractRequestedDashboardTitle, findMachineIdsInText } from './dashboardCloneParse';

export const PEER_RF_PANEL_TITLE = 'Module 5 Current — RandomForest vs Peers (Influx)';

export interface AddPeerRfPanelRequest {
    dashboardUid?: string;
    dashboardTitle?: string;
    machineId?: string;
}

function normalizeMessageQuotes(text: string): string {
    return text.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
}

export function messageMentionsAddPeerRfPanel(message: string): boolean {
    const text = normalizeMessageQuotes(message.trim());
    if (!text) {
        return false;
    }
    return (
        (/\b(add|create|new)\b/i.test(text) && /\bpeer\s*rf\b/i.test(text)) ||
        (/\brandomforest\s+vs\s+peers\b/i.test(text) && /\b(add|create|panel)\b/i.test(text)) ||
        (/\bpeer\s+random\s*forest\b/i.test(text) && /\b(influx|panel|dashboard)\b/i.test(text))
    );
}

export function parseAddPeerRfPanelRequest(message: string): AddPeerRfPanelRequest | null {
    const text = normalizeMessageQuotes(message.trim());
    if (!messageMentionsAddPeerRfPanel(text)) {
        return null;
    }
    const uids = extractAllDashboardUids(text);
    const machines = findMachineIdsInText(text);
    const machineId = machines[0];
    const dashboardTitle = extractRequestedDashboardTitle(text, machineId);
    const dashboardUid = uids[0] ?? extractDashboardUidFromMessage(text);
    if (!dashboardUid && !dashboardTitle && !machineId) {
        return null;
    }
    return { dashboardUid, dashboardTitle, machineId };
}

export function formatAddPeerRfPanelExamplePrompt(dashboardUid = '6gawrgawrgragg'): string {
    return (
        `On dashboard uid ${dashboardUid}, add panel "${PEER_RF_PANEL_TITLE}" next to the Module 5 peer-band panel. ` +
        `Use peer RandomForest bands (model=peer_rf). Do not change other panels.`
    );
}
