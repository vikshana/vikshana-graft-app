import { extractAllDashboardUids, extractDashboardUidFromMessage } from './dashboardMentionParse';
import { extractRequestedDashboardTitle, findMachineIdsInText } from './dashboardCloneParse';
import { extractOnDashboardMachineTitle } from './modulePanelReorderParse';
import { extractOwnHistoryMetricLabel } from './ownHistoryPanelParse';
import { extractInstrumentationLabel } from './dashboardMetricPanelsParse';
import {
    formatModuleMlPanelGuidanceReply,
    parseModuleMlGuidanceContext,
} from './moduleMlPanelGuidance';

export const DEFAULT_HISTORY_COMPARISON_MODULE = 5;

export interface AddHistoryComparisonPanelRequest {
    dashboardUid?: string;
    dashboardTitle?: string;
    titleLabel?: string;
    machineId?: string;
    moduleNumber: number;
}

function normalizeMessageQuotes(text: string): string {
    return text.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
}

function userWantsPanelAction(text: string): boolean {
    return (
        /\b(add|create|new|make|build|set\s+up)\b/i.test(text) ||
        /\bwould\s+like\s+to\s+(?:add|create|make|build|set\s+up)\b/i.test(text)
    );
}

/** Predictive analytics / live History Comparison (PromQL RandomForest bands). */
export function messageMentionsPredictiveAnalyticsPanel(message: string): boolean {
    const text = normalizeMessageQuotes(message.trim());
    if (!text) {
        return false;
    }
    if (/\bown\s+history\b/i.test(text) || (/\bvs\.?\s*own\b/i.test(text) && /\b2\s*σ|2\s*sigma/i.test(text))) {
        return false;
    }
    if (/\brandomforest\s+vs\s+peers\b/i.test(text) || /\bpeer\s*rf\b/i.test(text)) {
        return false;
    }
    // Peer Band ±2σ (Flux peer mean) — not History Comparison / RandomForest.
    if (
        /\bpeer\s*band\b/i.test(text) ||
        /\bpeer\s+mean\b/i.test(text) ||
        /\bupper\s+peer\s+bound\b/i.test(text) ||
        /\blower\s+peer\s+bound\b/i.test(text) ||
        /\baverage\s+of\s+modules?\b/i.test(text)
    ) {
        return false;
    }
    return (
        /\bpredictive\s+analytics\b/i.test(text) ||
        /\bhistory\s+comparison\b/i.test(text) ||
        (/\brandom\s*forest\b/i.test(text) && !/\bvs\s+peers\b/i.test(text) && !/\binflux\b/i.test(text)) ||
        (/\bmachine\s+learning\b/i.test(text) &&
            /\bmodule\s*\d+\b/i.test(text) &&
            !/\bown\s+history\b/i.test(text) &&
            /\bpanel\b/i.test(text))
    );
}

export function parseAddHistoryComparisonPanelRequest(message: string): AddHistoryComparisonPanelRequest | null {
    const text = normalizeMessageQuotes(message.trim());
    if (!messageMentionsPredictiveAnalyticsPanel(text)) {
        return null;
    }
    if (!userWantsPanelAction(text)) {
        return null;
    }
    const uids = extractAllDashboardUids(text);
    const machines = findMachineIdsInText(text);
    const machineId = machines[0];
    const titleLabel = extractInstrumentationLabel(text);
    const dashboardTitle =
        extractRequestedDashboardTitle(text, machineId) ??
        extractOnDashboardMachineTitle(text) ??
        titleLabel;
    const dashboardUid = uids[0] ?? extractDashboardUidFromMessage(text);

    let moduleNumber: number | undefined;
    const phrase = extractOwnHistoryMetricLabel(text);
    if (phrase) {
        const mm = phrase.match(/\bmodule\s*(\d+)\b/i);
        if (mm?.[1]) {
            const n = parseInt(mm[1], 10);
            if (Number.isFinite(n) && n >= 1 && n <= 8) {
                moduleNumber = n;
            }
        }
    }
    if (moduleNumber == null) {
        const modMatch = text.match(/\bmodule\s*(\d+)\b/i);
        if (modMatch?.[1]) {
            const n = parseInt(modMatch[1], 10);
            if (Number.isFinite(n) && n >= 1 && n <= 8) {
                moduleNumber = n;
            }
        }
    }
    if (moduleNumber == null) {
        moduleNumber = DEFAULT_HISTORY_COMPARISON_MODULE;
    }
    if (!dashboardUid && !dashboardTitle && !machineId && !titleLabel) {
        return null;
    }
    return { dashboardUid, dashboardTitle, titleLabel, machineId, moduleNumber };
}

/** @deprecated Use formatModuleMlPanelGuidanceReply — kept for tests referencing example prompts. */
export function formatAddHistoryComparisonPanelExamplePrompt(moduleNumber = 5, dashboardUid = '6gawrgawrgragg'): string {
    return formatModuleMlPanelGuidanceReply(
        parseModuleMlGuidanceContext(
            `Create a predictive analytics panel for Module ${moduleNumber} Current on the dashboard with UID = ${dashboardUid}.`
        )
    );
}
