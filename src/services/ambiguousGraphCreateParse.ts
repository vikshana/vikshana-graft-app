import { extractDashboardUidFromMessage } from './dashboardMentionParse';
import { findMachineIdsInText } from './dashboardCloneParse';
import { userWantsDashboardMetricPanels } from './dashboardMetricPanelsParse';
import { messageDescribesDashboardRowWithPanels } from './dashboardRowWithPanelsParse';
import {
    messageDescribesMultiPanelCreate,
    messageDescribesPanelCreate,
} from './panelCreateParse';
import { formatDashboardMetricPanelsExamplePrompt } from './dashboardMetricPanelsParse';
import { KNOWN_INSTRUMENTATION_DASHBOARD_UIDS } from './programmaticDashboardResolve';

function normalizeMessageQuotes(text: string): string {
    return text.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
}

function hasDashboardAnchor(text: string): boolean {
    return Boolean(
        extractDashboardUidFromMessage(text) ||
            /\bkeysight\b/i.test(text) ||
            findMachineIdsInText(text).length > 0 ||
            /\bon\s+(?:the\s+)?dashboard\b/i.test(text)
    );
}

function hasSpecificPanelSpecification(text: string, contextDashboardUid?: string): boolean {
    return (
        messageDescribesPanelCreate(text) ||
        messageDescribesMultiPanelCreate(text, contextDashboardUid) ||
        userWantsDashboardMetricPanels(text) ||
        messageDescribesDashboardRowWithPanels(text, contextDashboardUid) ||
        /\b(gauge|stat|table|time\s*series|timeseries|bar\s*chart)\s+panel\b/i.test(text) ||
        /\bpanel\s+(?:called|named|titled)\b/i.test(text) ||
        /\b\d{1,3}\s+panels?\b/i.test(text)
    );
}

/** Vague "create useful graphs/charts" without typed panel specs — needs clarification or programmatic bulk metrics. */
export function messageDescribesAmbiguousGraphCreate(
    message: string,
    contextDashboardUid?: string
): boolean {
    const text = normalizeMessageQuotes(message.trim());
    if (!text || !hasDashboardAnchor(text)) {
        return false;
    }
    if (hasSpecificPanelSpecification(text, contextDashboardUid)) {
        return false;
    }
    const createVerb = /\b(create|add|make|build)\b/i.test(text);
    const graphNoun = /\b(graphs?|charts?|visuali[sz]ations?)\b/i.test(text);
    const vagueUsefulness =
        /\b(useful|appropriate|helpful|good|monitoring|recommend|suggest)\b/i.test(text);
    if (!createVerb || !graphNoun) {
        return false;
    }
    return vagueUsefulness || /\bfor\s+(?:the\s+)?keysight\b/i.test(text);
}

export function formatAmbiguousGraphCreateClarification(
    message: string,
    dashboardUid = KNOWN_INSTRUMENTATION_DASHBOARD_UIDS.keysight
): string {
    const keysight = /\bkeysight\b/i.test(message);
    const uid = extractDashboardUidFromMessage(message) ?? dashboardUid;
    const metricExample = formatDashboardMetricPanelsExamplePrompt(uid, 50);
    const multiPanelExample = `Create a gauge panel, time series panel, table panel, and stat panel for dashboard with UID = ${uid}.`;
    const rowExample = `Create a dashboard row called "Machine Health" and add two panels to it for dashboard with UID = ${uid}.`;

    return (
        `### Need clarification\n\n` +
        `Graft needs a **specific panel plan** before creating graphs. ` +
        `A prompt like "create useful graphs" does not specify panel types, titles, or metrics — ` +
        `the LLM may describe panels that are never saved.\n\n` +
        `**Choose one of these patterns:**\n` +
        `- **Bulk metrics** (programmatic, Prometheus \`machine_metrics\`):\n` +
        `  \`${metricExample}\`\n` +
        `- **Typed panels** (programmatic):\n` +
        `  \`${multiPanelExample}\`\n` +
        `- **Row + panels** (programmatic):\n` +
        `  \`${rowExample}\`\n` +
        (keysight
            ? `- **Keysight**: use Prometheus \`machine_metrics{machine="2505-200033", field="..."}\` — not standalone metric names or Influx \`keysight_machine\`.\n`
            : '') +
        `\nReply with one of the examples above (edit titles/types as needed).`
    );
}
