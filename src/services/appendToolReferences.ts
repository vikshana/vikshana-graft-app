import type { ToolExecution } from '../types/llm.types';
import {
    isDashboardCloneSession,
    latestNonContinueUserMessage,
    resolveDashboardCloneIntent,
    userWantsDashboardPanelFix,
} from './dashboardCloneProgress';
import {
    applyOperatorFriendlyDashboardSaveReply,
    hasSuccessfulDashboardSave,
} from './dashboardConciseSaveReply';
import {
    applyOperatorFriendlyPanelFixReply,
    isPanelFixSession,
    isPanelFixUserMessage,
    shouldUseConcisePanelReply,
} from './dashboardPanelFixReply';
import { applyOperatorFriendlyDashboardReply } from './dashboardTaskStatus';
import { isDashboardDataInvestigationQuestion } from './dashboardInvestigation';
import { formatClarificationIfNeeded } from './requestClarity';
import { isExplicitSinglePanelCopyRequest } from './singlePanelCopyParse';
import { messageDescribesPanelRename, userWantsPanelRename } from './panelRenameParse';
import { appendSuggestedQueryHint } from './suggestedQueryHint';
import { stripPanelIndexTables } from './dashboardTaskStatus';
import { formatCompactLookupHint } from './dashboardSaveReplyUtils';

function shouldUsePlainEnglishCloneReply(
    recentUserMessages: string[],
    fallbackUserMessage = ''
): boolean {
    const latest = latestNonContinueUserMessage(recentUserMessages) ?? fallbackUserMessage.trim();
    if (latest && (userWantsDashboardPanelFix(latest) || isExplicitSinglePanelCopyRequest(latest))) {
        return false;
    }
    if (latest && !resolveDashboardCloneIntent(recentUserMessages)) {
        return false;
    }
    return Boolean(resolveDashboardCloneIntent(recentUserMessages));
}

/** Format assistant reply for operators (plain English for clone sessions). */
export function appendDashboardReferencesToReply(
    content: string,
    toolExecutions: ToolExecution[],
    recentUserMessages: string[] = [],
    fallbackUserMessage = '',
    options?: { finalize?: boolean }
): string {
    const latestUser =
        latestNonContinueUserMessage(recentUserMessages) ?? fallbackUserMessage.trim();

    if (
        isDashboardDataInvestigationQuestion(latestUser) ||
        isDashboardDataInvestigationQuestion(fallbackUserMessage)
    ) {
        const stripped = stripPanelIndexTables(content);
        const base = stripped.length > 0 ? stripped : content.trim();
        return appendSuggestedQueryHint(base, fallbackUserMessage, toolExecutions);
    }

    const clarification = formatClarificationIfNeeded(latestUser);
    const savedThisTurn = toolExecutions.some(
        (t) => t.name === 'update_dashboard' && t.status === 'success'
    );
    const panelFixTurn =
        isPanelFixUserMessage(fallbackUserMessage) ||
        isPanelFixSession(recentUserMessages, fallbackUserMessage);

    if (clarification && !savedThisTurn && !panelFixTurn) {
        return clarification;
    }

    if (
        panelFixTurn ||
        shouldUseConcisePanelReply(content, toolExecutions, recentUserMessages, fallbackUserMessage)
    ) {
        return applyOperatorFriendlyPanelFixReply(
            content,
            toolExecutions,
            recentUserMessages,
            fallbackUserMessage,
            options
        );
    }

    if (shouldUsePlainEnglishCloneReply(recentUserMessages, fallbackUserMessage)) {
        return applyOperatorFriendlyDashboardReply(
            content,
            toolExecutions,
            recentUserMessages,
            fallbackUserMessage
        );
    }

    if (savedThisTurn) {
        if (userWantsPanelRename(latestUser) || messageDescribesPanelRename(latestUser)) {
            return (
                `### Panel rename should be programmatic\n\n` +
                `This turn saved via the LLM instead of the panel-rename handler. ` +
                `Hard-refresh (**Cmd+Shift+R**) so the chat badge shows the latest build, then send the same prompt again. ` +
                `You should see **Panel renamed**, not **Done (dashboard saved)**.`
            );
        }
        return applyOperatorFriendlyDashboardSaveReply(
            content,
            toolExecutions,
            recentUserMessages,
            fallbackUserMessage
        );
    }

    let out = stripPanelIndexTables(content);
    const compact = formatCompactLookupHint(toolExecutions);
    if (compact && !out.includes('Dashboards found')) {
        out = out.trim() ? `${out.trim()}\n\n${compact}` : compact;
    }
    return out;
}

/** True if the model claimed a dashboard save without a successful update_dashboard tool call. */
export function claimsDashboardSaveWithoutTool(content: string, toolExecutions: ToolExecution[]): boolean {
    const claimed =
        /\b(successfully updated|I've updated|dashboard was saved|titles now read|all \d+ panel)/i.test(content);
    const saved = toolExecutions.some((t) => t.name === 'update_dashboard' && t.status === 'success');
    return claimed && !saved;
}

/** True if the model asked the user to choose instead of saving. */
export function asksUserToChooseWithoutSave(
    content: string,
    toolExecutions: ToolExecution[]
): boolean {
    const saved = toolExecutions.some((t) => t.name === 'update_dashboard' && t.status === 'success');
    if (saved) {
        return false;
    }
    return (
        /\b(Would you like|Which would you prefer|Should I also|Do you want me to|Please choose|Let me know which|option 1|option 2)\b/i.test(
            content
        ) ||
        /\b(Could you please provide|I need more context|need more context|clarify what items)\b/i.test(content) ||
        (/\b(keep them at the end|RandomForest panels)\b/i.test(content) && /\b(Should I|Would you)\b/i.test(content))
    );
}

export function appendSaveVerificationWarning(
    content: string,
    toolExecutions: ToolExecution[],
    recentUserMessages: string[] = [],
    fallbackUserMessage = ''
): string {
    if (
        shouldUseConcisePanelReply(content, toolExecutions, recentUserMessages, fallbackUserMessage) ||
        shouldUsePlainEnglishCloneReply(recentUserMessages, fallbackUserMessage) ||
        hasSuccessfulDashboardSave(toolExecutions)
    ) {
        return content;
    }
    if (claimsDashboardSaveWithoutTool(content, toolExecutions)) {
        return (
            `${content.trim()}\n\n---\n` +
            `**Note:** No confirmed dashboard save was recorded in this turn. ` +
            `Expand the tool steps above or ask Graft to try again.\n`
        );
    }
    if (asksUserToChooseWithoutSave(content, toolExecutions)) {
        return (
            `${content.trim()}\n\n---\n` +
            `**Note:** Graft stopped for confirmation before saving. Reply **Continue** to proceed.\n`
        );
    }
    return content;
}
