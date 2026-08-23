import { isCloneHowToQuestion, parseCloneIntentMessage } from './dashboardCloneParse';
import { userWantsDashboardClone, userWantsDashboardPanelFix } from './dashboardCloneProgress';
import { isDashboardDataInvestigationQuestion } from './dashboardInvestigation';
import {
    extractDashboardUidFromMessage,
    extractPanelIdFromMessage,
    mentionsDashboard,
} from './dashboardMentionParse';
import { extractDashboardTitleFromFixRequest } from './dashboardPanelFixReply';
import { isScopedPanelFixRequest, parseScopedPanelFixRequest } from './panelFixScope';
import { getPanelFixScope } from './panelFixSessionStorage';
import { isPanelFixVerificationRequest } from './panelFixVerification';
import {
    formatBulkPeerBandFixClarification,
    messageMentionsPeerBandPanelsButNotBulkFix,
} from './bulkPeerBandFixParse';
import {
    formatPeerBandPanelCopyClarification,
    messageMentionsPeerBandPanelCopyIntent,
    parsePeerBandPanelCopyRequest,
} from './peerBandPanelCopyParse';
import {
    formatSinglePanelCopyClarification,
    messageMentionsSinglePanelCopyIntent,
    parseSinglePanelCopyRequest,
} from './singlePanelCopyParse';
import {
    formatDashboardRenameClarification,
    messageDescribesDashboardRename,
    parseDashboardRenameRequest,
} from './dashboardRenameParse';
import {
    formatPanelRenameClarification,
    messageDescribesPanelRename,
    parsePanelRenameRequest,
} from './panelRenameParse';
import {
    formatAmbiguousGraphCreateClarification,
    messageDescribesAmbiguousGraphCreate,
} from './ambiguousGraphCreateParse';
import { recordClarificationShown } from './graftPromptLearning';
import { messageHasProgrammaticHandler } from './programmaticChatIntents';

/** Enough to identify a dashboard for panel fix (uid, machine id, or title). */
export function hasDashboardIdentityForPanelFix(message: string): boolean {
    if (isScopedPanelFixRequest(message) || parseScopedPanelFixRequest(message)) {
        return true;
    }
    if (getPanelFixScope()?.dashboardUid) {
        return true;
    }
    if (extractDashboardTitleFromFixRequest(message)) {
        return true;
    }
    if (/[0-9]{4}-[0-9]+/.test(message)) {
        return true;
    }
    if (mentionsDashboard(message) && /\buid\b/i.test(message) && /[a-zA-Z0-9]{6,}/.test(message)) {
        return true;
    }
    if (extractPanelIdFromMessage(message) && mentionsDashboard(message)) {
        return true;
    }
    if (extractDashboardUidFromMessage(message)) {
        return true;
    }
    return false;
}

/**
 * When the user's Grafana request is too vague to act on safely, return a short
 * clarification prompt (shown instead of a long tool-heavy reply).
 */
export function formatClarificationIfNeeded(userMessage: string): string | null {
    const text = userMessage.trim();
    if (!text) {
        return null;
    }

    if (isCloneHowToQuestion(text)) {
        return null;
    }

    if (isDashboardDataInvestigationQuestion(text)) {
        return null;
    }

    if (isPanelFixVerificationRequest(text) && getPanelFixScope()?.dashboardUid) {
        return null;
    }

    const seemsGrafanaTask =
        /\b(dashboard|dash\s*board|panels?|grafana|clone|copy|rename|duplicate|fix|repair|prometheus|loki|machine|uid|plant|analytics|keysight|skywater|\bML\b)\b/i.test(
            text
        );
    if (!seemsGrafanaTask) {
        return null;
    }

    if (messageMentionsPeerBandPanelsButNotBulkFix(text)) {
        return formatBulkPeerBandFixClarification(extractDashboardUidFromMessage(text));
    }

    if (messageMentionsPeerBandPanelCopyIntent(text) && !parsePeerBandPanelCopyRequest(text)) {
        return formatPeerBandPanelCopyClarification(text);
    }

    if (messageMentionsSinglePanelCopyIntent(text) && !parseSinglePanelCopyRequest(text)) {
        return formatSinglePanelCopyClarification(text);
    }

    if (messageDescribesPanelRename(text)) {
        if (parsePanelRenameRequest(text)) {
            return null;
        }
        return formatPanelRenameClarification(text);
    }

    if (messageDescribesAmbiguousGraphCreate(text)) {
        recordClarificationShown(
            'ambiguous-graph-create',
            text,
            extractDashboardUidFromMessage(text)
        );
        return formatAmbiguousGraphCreateClarification(text);
    }

    if (messageDescribesDashboardRename(text)) {
        if (parseDashboardRenameRequest(text)) {
            return null;
        }
        return formatDashboardRenameClarification(text);
    }

    if (userWantsDashboardClone(text)) {
        const parsed = parseCloneIntentMessage(text);
        if (!parsed.valid && parsed.error) {
            return (
                `### Need clarification\n\n` +
                `${parsed.error}\n\n` +
                `**Example:** \`Create a dashboard for 2505-200033 that is a copy of 2103-176030, with data for 2505-200033.\``
            );
        }
        return null;
    }

    if (isPanelFixVerificationRequest(text) && !hasDashboardIdentityForPanelFix(text)) {
        return (
            `### Need clarification\n\n` +
            `Which panel should Graft verify? Include dashboard **uid** and panel name or panel id, ` +
            `or fix a panel first in this chat (Graft remembers the last dashboard and panel).`
        );
    }

    if (userWantsDashboardPanelFix(text)) {
        if (!hasDashboardIdentityForPanelFix(text)) {
            return (
                `### Need clarification\n\n` +
                `Which dashboard should Graft fix? Include:\n` +
                `- Dashboard **uid** (e.g. \`6gawrgawrgragg\`) or title (e.g. **2505-200033 / Keysight**)\n` +
                `- **Panel id** or panel name, and what is wrong (PromQL error, wrong machine, etc.)`
            );
        }
        return null;
    }

    const veryShort = text.length < 45;
    const mentionsDashOrPanel = /\b(dashboard|panels?)\b/i.test(text);
    const hasMachineOrUid = /[0-9]{4}-[0-9]+/.test(text) || /\buid=/i.test(text);
    if (veryShort && mentionsDashOrPanel && !hasMachineOrUid) {
        return (
            `### Need clarification\n\n` +
            `Graft is not sure which dashboard or panels you mean. Please include:\n` +
            `- Dashboard title or machine id (e.g. **2505-200033 / Keysight**)\n` +
            `- What to fix (errors, wrong machine id, or a panel name)\n\n` +
            `**Example:** \`Fix panels on 2505-200033 / Keysight that still use 2103-176030.\``
        );
    }

    if (isCloneHowToQuestion(text)) {
        return null;
    }

    const wantsChange =
        /\b(add|create|clone|copy|rename|fix|remove|rebuild|duplicate|make|build|set\s+up)\b/i.test(text) ||
        /\b(machine learning|\bML\b|random\s*forest|own history|peer band|history comparison|analytics)\b/i.test(text);
    if (wantsChange && !messageHasProgrammaticHandler(text)) {
        return (
            `### Need clarification\n\n` +
            `Graft did not match that wording to a known action. Say which of these you mean, and include a dashboard **uid** or title:\n` +
            `- Copy/clone a dashboard\n` +
            `- Rename a dashboard or panel\n` +
            `- Add Own History, History Comparison, RandomForest vs Peers, or Peer Band\n` +
            `- Fix or remove a panel\n\n` +
            `**Example:** \`Create a RandomForest vs Peers panel for Module 3 Current on the dashboard with UID = idHkqdqnk.\``
        );
    }

    return null;
}
