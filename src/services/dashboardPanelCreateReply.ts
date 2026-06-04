import type { ToolExecution } from '../types/llm.types';
import {
    describesDashboardCloneLayoutIntent,
    latestNonContinueUserMessage,
    userWantsDashboardPanelFix,
} from './dashboardCloneProgress';
import {
    isExplicitSinglePanelCopyRequest,
    messageMentionsSinglePanelCopyIntent,
} from './singlePanelCopyParse';
import { stripPanelIndexTables } from './dashboardTaskStatus';
import {
    HARD_REFRESH_LINE,
    resolveSavedDashboardLabel,
    savedVersionFromTools,
} from './dashboardSaveReplyUtils';

export function userWantsPanelCreate(message: string): boolean {
    const text = message.trim();
    if (!text) {
        return false;
    }
    if (
        isExplicitSinglePanelCopyRequest(text) ||
        messageMentionsSinglePanelCopyIntent(text) ||
        describesDashboardCloneLayoutIntent(text)
    ) {
        return false;
    }
    if (/\b(visual copy|clone|new dashboard)\b/i.test(text)) {
        return false;
    }
    if (/\bcopy of\b/i.test(text) && /\bpanel\b/i.test(text)) {
        return false;
    }
    if (userWantsDashboardPanelFix(text)) {
        return false;
    }
    return (
        (/\b(create|add|make)\b/i.test(text) && /\b(panel|gauge)\b/i.test(text)) ||
        /\bnew\s+(?:pressure\s+)?gauge\b/i.test(text) ||
        (/\b(create|add)\b/i.test(text) && /\bdashboard\b/i.test(text) && /\bpanel/i.test(text))
    );
}

interface ParsedCreateDetails {
    headline?: string;
    panelTitle?: string;
    panelId?: string;
    panelType?: string;
    version?: string;
}

function parseCreateDetailsFromModel(text: string): ParsedCreateDetails {
    const stripped = stripPanelIndexTables(text);
    const headline = stripped.match(/✅[^\n]+/i)?.[0]?.trim();
    const panelTitle =
        stripped.match(/\*\*Panel title:\*\*\s*([^\n]+)/i)?.[1]?.trim() ??
        stripped.match(/Panel title:\s*([^\n]+)/i)?.[1]?.trim();
    const panelId =
        stripped.match(/\*\*Panel ID:\*\*\s*(\d+)/i)?.[1] ??
        stripped.match(/Panel ID:\s*(\d+)/i)?.[1];
    const panelType =
        stripped.match(/\*\*Type:\*\*\s*([^\n]+)/i)?.[1]?.trim() ??
        stripped.match(/Type:\s*([^\n]+)/i)?.[1]?.trim();
    const version =
        stripped.match(/\*\*Dashboard version:\*\*\s*(\d+)/i)?.[1] ??
        stripped.match(/version[:\s]+(\d+)/i)?.[1];
    return { headline, panelTitle, panelId, panelType, version };
}

function panelTypeLabel(type: string | undefined, userRequest: string): string {
    if (type) {
        return type;
    }
    if (/\bgauge\b/i.test(userRequest)) {
        return 'gauge';
    }
    if (/\bpressure\b/i.test(userRequest)) {
        return 'pressure panel';
    }
    return 'panel';
}

/** Plain-English reply for add/create panel requests — summary last, no index tables. */
export function applyOperatorFriendlyPanelCreateReply(
    content: string,
    toolExecutions: ToolExecution[],
    recentUserMessages: string[] = [],
    fallbackUserMessage = ''
): string {
    const latest = latestNonContinueUserMessage(recentUserMessages) ?? fallbackUserMessage.trim();
    const stripped = stripPanelIndexTables(content);
    const parsed = parseCreateDetailsFromModel(stripped);
    const dashboard = resolveSavedDashboardLabel(toolExecutions, latest, stripped);
    const version = parsed.version ?? savedVersionFromTools(toolExecutions);
    const versionBit = version ? ` (version **${version}**)` : '';
    const panelTitle = parsed.panelTitle ?? 'new panel';
    const panelIdBit = parsed.panelId ? ` (panel id **${parsed.panelId}**)` : '';
    const typeLabel = panelTypeLabel(parsed.panelType, latest);

    const savedLine =
        parsed.headline?.replace(/^✅\s*/u, '').trim() ??
        `New ${typeLabel} panel **${panelTitle}** created and saved to ${dashboard}`;

    return (
        `### Done (panel added)\n\n` +
        `✅ ${savedLine}${panelIdBit}. Dashboard saved${versionBit}.\n\n` +
        HARD_REFRESH_LINE.replace('see changes', 'see the new panel')
    );
}
