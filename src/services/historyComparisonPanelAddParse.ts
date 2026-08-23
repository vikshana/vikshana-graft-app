import { extractAllDashboardUids, extractDashboardUidFromMessage } from './dashboardMentionParse';
import { extractRequestedDashboardTitle, findMachineIdsInText } from './dashboardCloneParse';
import { extractOnDashboardMachineTitle } from './modulePanelReorderParse';
import { extractOwnHistoryMetricLabel } from './ownHistoryPanelParse';
import { extractInstrumentationLabel } from './dashboardMetricPanelsParse';
import {
    formatModuleMlPanelGuidanceReply,
    parseModuleMlGuidanceContext,
} from './moduleMlPanelGuidance';
import {
    canonicalLiveHistoryComparisonTitle,
    canonicalLiveHistoryComparisonTitleForLabel,
} from './modulePanelTitles';

export const DEFAULT_HISTORY_COMPARISON_MODULE = 5; // example prompts only — parse requires explicit module/metric


export interface HistoryComparisonSignal {
    /** Prometheus machine_metrics field tag. */
    field: string;
    /** Panel title without the " — History Comparison" suffix base. */
    titleBase: string;
    /** Full panel title. */
    panelTitle: string;
    /** Grafana unit id. */
    unit: string;
    /** Optional module number when the signal is module-scoped. */
    moduleNumber?: number;
}

export interface AddHistoryComparisonPanelRequest {
    dashboardUid?: string;
    dashboardTitle?: string;
    titleLabel?: string;
    machineId?: string;
    /** Set for Module N Current (and Module N Voltage) RF panels. */
    moduleNumber?: number;
    /**
     * Non-module (or free-text) signal from "panel for <X>", e.g. "sensing voltage".
     * When set, do not default to Module 5 Current.
     */
    metricLabel?: string;
    /** Resolved PromQL field + title + unit (filled by parse). */
    signal?: HistoryComparisonSignal;
}

function normalizeMessageQuotes(text: string): string {
    return text.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
}

function userWantsPanelAction(text: string): boolean {
    return (
        /\b(add|create|new|make|build|set\s+up)\b/i.test(text) ||
        /\bwould\s+like\s+to\s+(?:add|create|make|build|set\s+up)\b/i.test(text) ||
        /\bplease\s+(?:add|create|make|build)\b/i.test(text)
    );
}

/**
 * Map free-text metric phrases to PromQL RF fields used by the ElectraMet ML exporter.
 */
export function resolveHistoryComparisonSignal(
    opts: { moduleNumber?: number; metricLabel?: string }
): HistoryComparisonSignal | undefined {
    const label = opts.metricLabel?.trim();
    if (label) {
        const lc = label.toLowerCase();
        const modVoltage = lc.match(/\bmodule\s*(\d+)\s+voltage\b/);
        if (modVoltage?.[1]) {
            const n = Number.parseInt(modVoltage[1], 10);
            if (Number.isFinite(n) && n >= 1 && n <= 8) {
                const titleBase = `Module ${n} Voltage`;
                return {
                    field: `Module${n}_Voltage_VDC`,
                    titleBase,
                    panelTitle: canonicalLiveHistoryComparisonTitleForLabel(titleBase),
                    unit: 'volt',
                    moduleNumber: n,
                };
            }
        }
        const modCurrent = lc.match(/\bmodule\s*(\d+)(?:\s+current)?\b/);
        if (modCurrent?.[1] && !/\bvoltage|pressure|flow|sensing|temperatures?\b/i.test(lc)) {
            const n = Number.parseInt(modCurrent[1], 10);
            if (Number.isFinite(n) && n >= 1 && n <= 8) {
                return {
                    field: `Module${n}_Current_A`,
                    titleBase: `Module ${n} Current`,
                    panelTitle: canonicalLiveHistoryComparisonTitle(n),
                    unit: 'amp',
                    moduleNumber: n,
                };
            }
        }
        if (/\baverage\s+sensing\s+voltage\b/i.test(lc)) {
            const titleBase = 'Average Sensing Voltage';
            return {
                field: 'Average_Sensing_Voltage',
                titleBase,
                panelTitle: canonicalLiveHistoryComparisonTitleForLabel(titleBase),
                unit: 'volt',
            };
        }
        if (/\bsensing\s+voltage\b/i.test(lc) || /\bcartridge\s+sensing\b/i.test(lc)) {
            const titleBase = 'Sensing Voltage';
            return {
                field: 'Cartridge_Sensing_Voltage',
                titleBase,
                panelTitle: canonicalLiveHistoryComparisonTitleForLabel(titleBase),
                unit: 'volt',
            };
        }
        if (/\btemperatures?\b/i.test(lc)) {
            const titleBase = 'Temperature';
            return {
                field: 'Temperature_C',
                titleBase,
                panelTitle: canonicalLiveHistoryComparisonTitleForLabel(titleBase),
                unit: 'celsius',
                moduleNumber: undefined,
            };
        }
        // Unknown free-text label (e.g. bare "pressure") — caller should clarify.
        return undefined;
    }

    const mod = opts.moduleNumber;
    if (mod != null && Number.isFinite(mod) && mod >= 1 && mod <= 8) {
        return {
            field: `Module${mod}_Current_A`,
            titleBase: `Module ${mod} Current`,
            panelTitle: canonicalLiveHistoryComparisonTitle(mod),
            unit: 'amp',
            moduleNumber: mod,
        };
    }
    return undefined;
}

/** Create-style RF / History Comparison prompt that did not resolve to a known signal. */
export function messageNeedsHistoryComparisonSignalClarification(message: string): boolean {
    const text = normalizeMessageQuotes(message.trim());
    if (!messageMentionsPredictiveAnalyticsPanel(text) || !userWantsPanelAction(text)) {
        return false;
    }
    return parseAddHistoryComparisonPanelRequest(text) == null;
}

/**
 * Clarify when the operator asked to create an RF panel for an unknown / ambiguous signal
 * (e.g. bare "pressure") instead of defaulting to Module 5 Current guidance.
 */
export function formatHistoryComparisonSignalClarification(message: string): string {
    const phrase = extractOwnHistoryMetricLabel(message)?.trim();
    const signalLine = phrase
        ? `I understood **${phrase}**, but that is not a supported Random Forest / History Comparison field yet.`
        : `I need a specific signal to chart — Random Forest / History Comparison panels are not a generic create.`;
    return (
        `### Need a clearer Random Forest signal\n\n` +
        `${signalLine}\n\n` +
        `Supported today:\n` +
        `- **Module N Current** (e.g. Module 2 Current)\n` +
        `- **Module N Voltage** (e.g. Module 2 Voltage)\n` +
        `- **Sensing Voltage** / **Average Sensing Voltage**\n\n` +
        `For Pressure / Flow statistical bands, use **Own History (±2σ)** or **Peer Band** instead.\n\n` +
        `Example:\n` +
        `> Create a Random Forest machine learning panel for Module 2 Current on the dashboard with UID = afq7tc6hl1m9sb.`
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
    const plantMetric = /\b(temperature|pressure|flow|sensing\s+voltage)\b/i.test(text);
    // Module-scoped "RF vs Peers" is peer-RF. Plant metrics (Temperature) are not.
    if (
        (/\brandomforest\s+vs\s+peers\b/i.test(text) || /\bpeer\s*rf\b/i.test(text)) &&
        /\bmodule\s*\d+\b/i.test(text) &&
        !plantMetric
    ) {
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
        (/\bML\b/i.test(text) &&
            /\btemperature/i.test(text) &&
            /\b(add|create|new|make|build|set\s+up|please)\b/i.test(text)) ||
        (/\brandom\s*forest\b/i.test(text) &&
            (!/\bvs\s+peers\b/i.test(text) || !/\bmodule\s*\d+\b/i.test(text)) &&
            !(/\binflux\b/i.test(text) && /\bmodule\s*\d+\b/i.test(text))) ||
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
    let metricLabel: string | undefined;
    const phrase = extractOwnHistoryMetricLabel(text);
    if (phrase) {
        const mm = phrase.match(/\bmodule\s*(\d+)\b/i);
        if (mm?.[1]) {
            const n = parseInt(mm[1], 10);
            if (Number.isFinite(n) && n >= 1 && n <= 8) {
                moduleNumber = n;
            }
        }
        // Keep free-text / Module N Voltage|Pressure|… as metricLabel so we do not
        // collapse "Module 2 Voltage" into Module 2 Current via moduleNumber alone.
        if (
            moduleNumber == null ||
            /\b(voltage|pressure|flow|sensing|current|temperatures?)\b/i.test(phrase)
        ) {
            metricLabel = phrase;
            // Pure "Module N Current" still resolves via moduleNumber in signal helper.
            if (/^\s*module\s*\d+\s+current\s*$/i.test(phrase)) {
                metricLabel = undefined;
            }
        }
    }
    if (moduleNumber == null && metricLabel == null) {
        const modMatch = text.match(/\bmodule\s*(\d+)\b/i);
        if (modMatch?.[1]) {
            const n = parseInt(modMatch[1], 10);
            if (Number.isFinite(n) && n >= 1 && n <= 8) {
                moduleNumber = n;
            }
        }
    }
    if (moduleNumber == null && metricLabel == null && /\btemperatures?\b/i.test(text)) {
        metricLabel = 'temperature';
    }
    if (moduleNumber == null && metricLabel == null) {
        // Do not invent Module 5 — require an explicit module or metric label.
        return null;
    }

    const signal = resolveHistoryComparisonSignal({ moduleNumber, metricLabel });
    if (!signal) {
        return null;
    }

    if (!dashboardUid && !dashboardTitle && !machineId && !titleLabel) {
        return null;
    }
    return {
        dashboardUid,
        dashboardTitle,
        titleLabel,
        machineId,
        moduleNumber: signal.moduleNumber,
        metricLabel,
        signal,
    };
}

/** @deprecated Use formatModuleMlPanelGuidanceReply — kept for tests referencing example prompts. */
export function formatAddHistoryComparisonPanelExamplePrompt(moduleNumber = 5, dashboardUid = '6gawrgawrgragg'): string {
    return formatModuleMlPanelGuidanceReply(
        parseModuleMlGuidanceContext(
            `Create a predictive analytics panel for Module ${moduleNumber} Current on the dashboard with UID = ${dashboardUid}.`
        )
    );
}
