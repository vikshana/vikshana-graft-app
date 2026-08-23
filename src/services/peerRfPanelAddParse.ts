import { extractAllDashboardUids, extractDashboardUidFromMessage } from './dashboardMentionParse';
import { extractRequestedDashboardTitle, findMachineIdsInText } from './dashboardCloneParse';
import { messageMentionsGrafanaAlertCreate, messageMentionsGrafanaAlertUpdate } from './grafanaAlertParse';

/** Peer-RF predicts ONE module's current from its peer modules, so the panel is module-scoped. */
export function peerRfPanelTitle(moduleNumber: number): string {
    return `Module ${moduleNumber} Current — RandomForest vs Peers (Influx)`;
}

/** Default (Module 5) title — kept for back-compat where no module is specified. */
export const PEER_RF_PANEL_TITLE = peerRfPanelTitle(5);

export const DEFAULT_PEER_RF_MODULE = 5; // example prompts / docs only — create path requires an explicit module


export interface AddPeerRfPanelRequest {
    dashboardUid?: string;
    dashboardTitle?: string;
    machineId?: string;
    /** Module whose current is modeled from its peers (defaults to 5 when unspecified). */
    moduleNumber?: number;
    /** When peer_rf is missing, call Graft backend enroll + queue backfill, then create. */
    enrollIfMissing?: boolean;
}

function normalizeMessageQuotes(text: string): string {
    return text.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
}

export function messageMentionsAddPeerRfPanel(message: string): boolean {
    const text = normalizeMessageQuotes(message.trim());
    if (!text) {
        return false;
    }
    if (messageMentionsGrafanaAlertCreate(text) || messageMentionsGrafanaAlertUpdate(text)) {
        return false;
    }
    // Plant-level signals (Temperature, Pressure, …) are not peer-RF modules.
    if (
        /\b(temperature|pressure|flow|sensing\s+voltage)\b/i.test(text) &&
        !/\bmodule\s*\d+\b/i.test(text)
    ) {
        return false;
    }
    return (
        (/\b(add|create|new)\b/i.test(text) && /\bpeer\s*rf\b/i.test(text)) ||
        (/\brandom\s*forest\s+vs\s+peers\b/i.test(text) && /\b(add|create|panel)\b/i.test(text)) ||
        (/\bpeer\s+random\s*forest\b/i.test(text) && /\b(influx|panel|dashboard)\b/i.test(text)) ||
        // "RandomForest anomaly detection" + module + peer modules
        (/\brandom\s*forest\b/i.test(text) &&
            /\bpeer\s+modules?\b/i.test(text) &&
            /\b(add|create|panel)\b/i.test(text) &&
            !/\bhistory\s+comparison\b/i.test(text) &&
            !/\bown\s+history\b/i.test(text) &&
            !/\bpeer\s*band\b/i.test(text))
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
    let moduleNumber: number | undefined;
    const modMatch = text.match(/\bmodule\s*(\d+)\b/i);
    if (modMatch?.[1]) {
        const n = parseInt(modMatch[1], 10);
        if (Number.isFinite(n) && n >= 1 && n <= 8) {
            moduleNumber = n;
        }
    }
    if (!dashboardUid && !dashboardTitle && !machineId) {
        return null;
    }
    const enrollIfMissing =
        /\benroll\b/i.test(text) ||
        (/\bset\s*up\b/i.test(text) && /\bpeer\s*[- ]?\s*rf\b/i.test(text));
    return { dashboardUid, dashboardTitle, machineId, moduleNumber, enrollIfMissing };
}

export function formatAddPeerRfPanelExamplePrompt(dashboardUid = '6gawrgawrgragg'): string {
    return (
        `On dashboard uid ${dashboardUid}, add panel "${PEER_RF_PANEL_TITLE}" next to the Module 5 peer-band panel. ` +
        `Use peer RandomForest bands (model=peer_rf). Do not change other panels.`
    );
}
