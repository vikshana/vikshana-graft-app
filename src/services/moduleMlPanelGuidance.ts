import { extractAllDashboardUids, extractDashboardUidFromMessage } from './dashboardMentionParse';
import { extractRequestedDashboardTitle } from './dashboardCloneParse';
import { extractOnDashboardMachineTitle } from './modulePanelReorderParse';
import { extractInstrumentationLabel } from './dashboardMetricPanelsParse';
import {
    canonicalLiveHistoryComparisonTitle,
    canonicalOwnHistoryTitle,
} from './modulePanelTitles';
import { peerRfPanelTitle } from './peerRfPanelAddParse';

export interface ModuleMlGuidanceContext {
    moduleNumber: number;
    dashboardLabel: string;
    dashboardUid?: string;
}

function normalizeMessageQuotes(text: string): string {
    return text.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
}

export function extractModuleNumberForMlPanel(message: string): number | undefined {
    const text = normalizeMessageQuotes(message.trim());
    const modMatch = text.match(/\bmodule\s*(\d+)\b/i);
    if (!modMatch?.[1]) {
        return undefined;
    }
    const n = parseInt(modMatch[1], 10);
    return Number.isFinite(n) && n >= 1 && n <= 8 ? n : undefined;
}

/** User is asking about ML / predictive analytics for a module current signal. */
export function messageMentionsModuleMlTopic(message: string): boolean {
    const text = normalizeMessageQuotes(message.trim());
    if (!text || !/\bmodule\s*\d+\b/i.test(text)) {
        return false;
    }
    if (/\bown\s+history\b/i.test(text) || (/\bvs\.?\s*own\b/i.test(text) && /\b2\s*σ|2\s*sigma/i.test(text))) {
        return true;
    }
    if (/\brandomforest\s+vs\s+peers\b/i.test(text) || /\bpeer\s*rf\b/i.test(text)) {
        return true;
    }
    return (
        /\bpredictive\s+analytics\b/i.test(text) ||
        /\bhistory\s+comparison\b/i.test(text) ||
        /\bmachine\s+learning\b/i.test(text) ||
        /\brandom\s*forest\b/i.test(text) ||
        /\bpredictive\b/i.test(text) ||
        /\balgorithm\b/i.test(text)
    );
}

/**
 * Educational / exploratory ML questions — recommend panel types instead of silently failing
 * or dumping a single technical copy-paste line.
 */
export function messageRequestsMlPanelGuidance(message: string): boolean {
    const text = normalizeMessageQuotes(message.trim());
    if (!messageMentionsModuleMlTopic(text)) {
        return false;
    }
    const explicitPanelCreate =
        /\bpanel\b/i.test(text) &&
        (/\bpredictive\s+analytics\b/i.test(text) ||
            /\bhistory\s+comparison\b/i.test(text) ||
            /\bown\s+history\b/i.test(text) ||
            /\bvs\.?\s*peers\b/i.test(text) ||
            /\bpeer\s*rf\b/i.test(text));
    if (explicitPanelCreate) {
        return false;
    }
    return (
        /\balgorithm\b/i.test(text) ||
        /\b(recommend|suggest|explain|help\s+me|how\s+(?:do|to|can)|learn|understand|guide|walk\s+me)\b/i.test(text) ||
        (!/\bpanel\b/i.test(text) &&
            (/\bmachine\s+learning\b/i.test(text) ||
                /\bpredictive\b/i.test(text) ||
                /\brandom\s*forest\b/i.test(text)))
    );
}

export function parseModuleMlGuidanceContext(message: string): ModuleMlGuidanceContext {
    const text = normalizeMessageQuotes(message.trim());
    const moduleNumber = extractModuleNumberForMlPanel(text) ?? 5;
    const dashboardUid = extractAllDashboardUids(text)[0] ?? extractDashboardUidFromMessage(text);
    const instrumentation = extractInstrumentationLabel(text);
    const dashboardTitle =
        extractRequestedDashboardTitle(text) ??
        extractOnDashboardMachineTitle(text) ??
        instrumentation;
    const dashboardLabel =
        instrumentation ??
        dashboardTitle ??
        (dashboardUid ? `dashboard \`${dashboardUid}\`` : 'your dashboard');
    return { moduleNumber, dashboardLabel, dashboardUid };
}

function dashboardPhrase(label: string, uid?: string): string {
    if (uid) {
        return `the dashboard with UID = ${uid}`;
    }
    if (/^dashboard `/i.test(label)) {
        return label;
    }
    return `the ${label} dashboard`;
}

/** Plain-English guide for operators new to Grafana ML panels. */
export function formatModuleMlPanelGuidanceReply(ctx: ModuleMlGuidanceContext): string {
    const dash = dashboardPhrase(ctx.dashboardLabel, ctx.dashboardUid);
    const mod = ctx.moduleNumber;
    const historyTitle = canonicalLiveHistoryComparisonTitle(mod);
    const ownHistoryTitle = canonicalOwnHistoryTitle(mod);
    const peerRfTitle = peerRfPanelTitle(mod);

    return (
        `### Machine learning panels for Module ${mod} Current\n\n` +
        `Graft does **not** train a new machine-learning model inside chat. On PowerTech machines, a **background ML exporter** already runs RandomForest models and writes predictions to Prometheus and Influx. Your job in Grafana is to add **panels** that visualize those predictions.\n\n` +
        `For **Module ${mod} Current** on ${dash}, there are three common panel types:\n\n` +
        `1. **${historyTitle}** (predictive analytics / live ML)\n` +
        `   - **Question it answers:** “Is this module behaving unlike **its own recent history**?”\n` +
        `   - **What you see:** Actual current (solid line) plus ML upper/lower bands and expected value.\n` +
        `   - **Best for:** Recent data (about the last 35 days) using live Prometheus metrics.\n\n` +
        `2. **${ownHistoryTitle}** (statistical, not ML)\n` +
        `   - **Question it answers:** “Is today’s reading outside a simple rolling mean ± 2σ on **this module only**?”\n` +
        `   - **What you see:** Actual, historical mean, and ±2σ bounds computed in Influx Flux.\n` +
        `   - **Best for:** Quick statistical bands without the RandomForest exporter.\n\n` +
        `3. **${peerRfTitle}**\n` +
        `   - **Question it answers:** “Is this module behaving unlike **the other modules** right now?”\n` +
        `   - **What you see:** Actual vs peer-RandomForest expected value and bands (\`model=peer_rf\` in Influx).\n` +
        `   - **Best for:** Spotting one module that diverges from modules 1–4 and 6–8.\n\n` +
        `**To add a panel, tell Graft which type you want.** Copy one of these (edit the module or dashboard name if needed):\n\n` +
        `- \`Create a predictive analytics panel for Module ${mod} Current on ${dash}.\`\n` +
        `- \`Create a vs. Own History (±2σ) machine learning panel for Module ${mod} Current on ${dash}.\`\n` +
        `- \`Create a RandomForest vs Peers (Influx) machine learning panel for Module ${mod} Current on ${dash}.\`\n\n` +
        `After Graft saves, **hard-refresh** the dashboard in Grafana (**Cmd+Shift+R** on Mac) to see the new panel. Use the **dashboard time picker** (top right) to choose the date range — do not set time overrides on individual panels.`
    );
}
