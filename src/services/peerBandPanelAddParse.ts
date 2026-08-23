import {
    extractAllDashboardUids,
    extractDashboardUidFromMessage,
    extractClaimedVendorDashboardUid,
} from './dashboardMentionParse';
import { extractRequestedDashboardTitle, findMachineIdsInText } from './dashboardCloneParse';
import { extractOnDashboardMachineTitle } from './modulePanelReorderParse';
import { messageMentionsOwnHistoryPanel } from './ownHistoryPanelParse';
import { messageMentionsAddPeerRfPanel } from './peerRfPanelAddParse';
import { messageMentionsGrafanaAlertCreate, messageMentionsGrafanaAlertUpdate } from './grafanaAlertParse';
import { isCrossDashboardPeerBandCopyIntent } from './peerBandShared';
import { userWantsBulkPeerBandFix } from './bulkPeerBandFixParse';

export interface AddPeerBandPanelRequest {
    dashboardUid?: string;
    dashboardTitle?: string;
    machineId?: string;
    moduleNumber: number;
    /** Peer modules to average (excluding the target module). */
    peerModules?: number[];
    panelTitle?: string;
    /**
     * Metric family from the prompt/title (Pressure, Current, …).
     * Drives Influx `_field` names — PressureN_psi vs ModuleN_Current_A.
     */
    metricKind?: PeerBandMetricKind;
}

/** ElectraMet recorder field families used in peer-band creates. */
export type PeerBandMetricKind = 'current' | 'voltage' | 'pressure' | 'flow';

export interface PeerBandMetricFields {
    kind: PeerBandMetricKind;
    /** Influx `_field` for the target module (e.g. Pressure2_psi, Module2_Current_A). */
    actualField: string;
    /** Peer `_field` names for the other modules. */
    peerFields: string[];
    unit: string;
    signalName: string;
}

/**
 * Map "Module N &lt;metric&gt;" to ElectraMet Influx field names from the PLC DataRecorder.
 * Pressure/Flow are PressureN_psi / FlowN_gpm — not ModuleN_*.
 */
export function resolvePeerBandMetricFields(
    moduleNumber: number,
    peerModules: number[],
    metricKind: PeerBandMetricKind = 'current'
): PeerBandMetricFields {
    const peers = peerModules.filter((n) => n !== moduleNumber && n >= 1 && n <= 8);
    if (metricKind === 'pressure') {
        return {
            kind: 'pressure',
            actualField: `Pressure${moduleNumber}_psi`,
            peerFields: peers.map((n) => `Pressure${n}_psi`),
            unit: 'psi',
            signalName: `Module ${moduleNumber} Pressure`,
        };
    }
    if (metricKind === 'flow') {
        return {
            kind: 'flow',
            actualField: `Flow${moduleNumber}_gpm`,
            peerFields: peers.map((n) => `Flow${n}_gpm`),
            unit: 'gpm',
            signalName: `Module ${moduleNumber} Flow`,
        };
    }
    if (metricKind === 'voltage') {
        return {
            kind: 'voltage',
            actualField: `Module${moduleNumber}_Voltage_VDC`,
            peerFields: peers.map((n) => `Module${n}_Voltage_VDC`),
            unit: 'volt',
            signalName: `Module ${moduleNumber} Voltage`,
        };
    }
    return {
        kind: 'current',
        actualField: `Module${moduleNumber}_Current_A`,
        peerFields: peers.map((n) => `Module${n}_Current_A`),
        unit: 'amp',
        signalName: `Module ${moduleNumber} Current`,
    };
}

/** Detect Pressure / Current / Voltage / Flow from title or "Compare Module N …" wording. */
export function extractPeerBandMetricKind(message: string, panelTitle?: string): PeerBandMetricKind {
    const blob = `${panelTitle ?? ''} ${normalizeMessageQuotes(message)}`;
    if (/\bpressure\b/i.test(blob)) {
        return 'pressure';
    }
    if (/\bflow\b/i.test(blob)) {
        return 'flow';
    }
    if (/\bvoltage\b/i.test(blob)) {
        return 'voltage';
    }
    return 'current';
}

function normalizeMessageQuotes(text: string): string {
    return text.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
}

/** Quoted / titled panel name from create prompts. */
export function extractPeerBandPanelTitle(message: string): string | undefined {
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
 * "Create … Peer Band ±2σ" / "Peer Mean" / "Upper Peer Bound" panel — not own-history,
 * peer-RF, bulk fix, or cross-dashboard copy.
 */
export function messageMentionsPeerBandPanelCreate(message: string): boolean {
    const text = normalizeMessageQuotes(message.trim());
    if (!text) {
        return false;
    }
    if (messageMentionsGrafanaAlertCreate(text) || messageMentionsGrafanaAlertUpdate(text)) {
        return false;
    }
    // "Add a description to the alarm titled … Peer Band …" is an alert update, not a panel create.
    if (
        /\b(?:alert|alarm)(?:\s+rule)?\s+(?:named|titled|called)\b/i.test(text) &&
        /\b(description|summary|label|annotation|contact\s*point)\b/i.test(text)
    ) {
        return false;
    }
    if (messageMentionsAddPeerRfPanel(text)) {
        return false;
    }
    if (isCrossDashboardPeerBandCopyIntent(text) || userWantsBulkPeerBandFix(text)) {
        return false;
    }
    // Own-history uses Historical Mean / Own History — keep those off this path.
    if (messageMentionsOwnHistoryPanel(text) && !/\bpeer\b/i.test(text)) {
        return false;
    }
    if (!/\b(add|create|new|make|plot|show|need|want|compare|build)\b/i.test(text)) {
        return false;
    }
    // Require creating a panel — do not match merely because free text contains "Pressure Panel".
    const createsPanel =
        /\b(?:create|add|make)\b[\s\S]{0,100}\b(?:machine\s+learning\s+)?(?:time\s+series\s+)?panel\b/i.test(
            text
        ) ||
        /\bnew\s+(?:machine\s+learning\s+)?(?:time\s+series\s+)?panel\b/i.test(text) ||
        /\bpanel\s+titled\b/i.test(text) ||
        (/\b(create|add|plot|show|compare|overlay|build|need)\b/i.test(text) &&
            /\bmodule\s*\d+\b/i.test(text) &&
            /\b(peer\s*band|peer\s+average|vs\.?\s*peers?)\b/i.test(text));
    if (!createsPanel) {
        return false;
    }

    const hasPeerBandTitle =
        /\bpeer\s*band\b/i.test(text) ||
        /\balert\s+test\s+peer\s*band\b/i.test(text) ||
        /\bpeer\s+average\b/i.test(text);
    const hasPeerMeanLines =
        /\bpeer\s+mean\b/i.test(text) ||
        (/\bupper\s+peer\s+bound\b/i.test(text) && /\blower\s+peer\s+bound\b/i.test(text));
    const hasPeerCompare =
        /\baverage\s+of\s+modules?\b/i.test(text) ||
        /\bmean\s+of\s+(?:the\s+)?(?:other\s+)?modules?\b/i.test(text) ||
        /\bcompare\s+module\s*\d+\b/i.test(text) ||
        /\bagainst\s+(?:the\s+)?(?:average|avg|mean)\b/i.test(text);

    return hasPeerBandTitle || (hasPeerMeanLines && hasPeerCompare) || (hasPeerMeanLines && hasPeerBandTitle);
}

/**
 * Parse "Modules 1 and 3 through 8" / "Modules 1–4, 6–8" into module numbers.
 */
export function extractPeerModulesFromMessage(message: string, excludeModule?: number): number[] | undefined {
    const text = normalizeMessageQuotes(message.trim());

    // "Modules 1 and 3 through 8"
    const andThrough = text.match(
        /\bmodules?\s+(\d+)\s+and\s+(\d+)\s+through\s+(\d+)\b/i
    );
    if (andThrough) {
        const a = Number.parseInt(andThrough[1], 10);
        const b = Number.parseInt(andThrough[2], 10);
        const c = Number.parseInt(andThrough[3], 10);
        if ([a, b, c].every((n) => Number.isFinite(n))) {
            const set = new Set<number>([a]);
            for (let n = Math.min(b, c); n <= Math.max(b, c); n++) {
                set.add(n);
            }
            return [...set]
                .filter((n) => n >= 1 && n <= 8 && n !== excludeModule)
                .sort((x, y) => x - y);
        }
    }

    // "Modules 1–4, 6–8" / "Modules 1-4,6-8"
    const rangeList = text.match(
        /\bmodules?\s*((?:\d+\s*[–\-—]\s*\d+\s*,?\s*)+)/i
    );
    if (rangeList?.[1]) {
        const set = new Set<number>();
        for (const part of rangeList[1].split(/[,;]/)) {
            const m = part.match(/(\d+)\s*[–\-—]\s*(\d+)/);
            if (!m) {
                continue;
            }
            const lo = Number.parseInt(m[1], 10);
            const hi = Number.parseInt(m[2], 10);
            if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
                continue;
            }
            for (let n = Math.min(lo, hi); n <= Math.max(lo, hi); n++) {
                set.add(n);
            }
        }
        if (set.size > 0) {
            return [...set]
                .filter((n) => n >= 1 && n <= 8 && n !== excludeModule)
                .sort((x, y) => x - y);
        }
    }

    return undefined;
}

export function parseAddPeerBandPanelRequest(
    message: string,
    opts?: { contextDashboardUid?: string }
): AddPeerBandPanelRequest | null {
    const text = normalizeMessageQuotes(message.trim());
    if (!messageMentionsPeerBandPanelCreate(text)) {
        return null;
    }
    if (extractClaimedVendorDashboardUid(text)) {
        return null;
    }

    const uids = extractAllDashboardUids(text);
    const machines = findMachineIdsInText(text);
    const machineId = machines[0];
    const dashboardTitle =
        extractRequestedDashboardTitle(text, machineId) ?? extractOnDashboardMachineTitle(text);
    const dashboardUid = uids[0] ?? extractDashboardUidFromMessage(text) ?? opts?.contextDashboardUid;
    const panelTitle = extractPeerBandPanelTitle(text);

    let moduleNumber: number | undefined;
    if (panelTitle) {
        const titleMod = panelTitle.match(/\bmodule\s*(\d+)\b/i);
        if (titleMod?.[1]) {
            const n = Number.parseInt(titleMod[1], 10);
            if (Number.isFinite(n) && n >= 1 && n <= 8) {
                moduleNumber = n;
            }
        }
    }
    if (moduleNumber == null) {
        const compareMod = text.match(/\bcompare\s+module\s*(\d+)\s+(?:pressure|current|voltage|flow)\b/i);
        const bareMod = text.match(/\bmodule\s*(\d+)\s+(?:pressure|current|voltage|flow)\b/i);
        const n = Number.parseInt((compareMod ?? bareMod)?.[1] ?? '', 10);
        if (Number.isFinite(n) && n >= 1 && n <= 8) {
            moduleNumber = n;
        }
    }
    if (moduleNumber == null) {
        return null;
    }

    if (!dashboardUid && !dashboardTitle && !machineId) {
        return null;
    }

    const peerModules = extractPeerModulesFromMessage(text, moduleNumber);
    const metricKind = extractPeerBandMetricKind(text, panelTitle);

    return {
        dashboardUid,
        dashboardTitle,
        machineId,
        moduleNumber,
        peerModules,
        panelTitle,
        metricKind,
    };
}

export function formatAddPeerBandPanelExamplePrompt(dashboardUid: string): string {
    return (
        `Create a new machine learning time series panel titled "Module 2 Current — Alert Test Peer Band ±2σ" ` +
        `on the dashboard with UID ${dashboardUid}. Compare Module 2 Current against the average of Modules 1 and 3 through 8. ` +
        `Create four visible lines: Module 2 Actual, Peer Mean, Upper Peer Bound, Lower Peer Bound. ` +
        `Calculate the Upper and Lower Peer Bounds in the Flux query itself.`
    );
}
