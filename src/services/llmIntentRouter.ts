import { isDashboardDataInvestigationQuestion } from './dashboardInvestigation';
import { userWantsDashboardReviewOnly } from './dashboardReviewParse';
import { isSimpleConversationalMessage, messageHasProgrammaticHandler } from './programmaticChatIntents';
import { messageDescribesPanelRemove, userWantsPanelRemove } from './panelRemoveParse';
import { messageDescribesPanelRename, userWantsPanelRename } from './panelRenameParse';

export type LlmIntentKind = 'conversational' | 'read_only' | 'mutating' | 'programmatic';

const READ_ONLY_VERB =
    /\b(review|suggest|recommend|analyze|analyse|audit|assess|inspect|evaluate|what|which|how many|list|show|explain|describe)\b/i;
const MUTATING_VERB =
    /\b(update|remove|delete|add|create|rename|fix|apply|implement|rebuild|reorganiz|copy|clone|move|change|edit)\b/i;

/** Classify how the LLM path should behave for a user message. */
export function classifyLlmIntent(userMessage: string, contextDashboardUid?: string): LlmIntentKind {
    const text = userMessage.trim();
    if (!text || isSimpleConversationalMessage(text)) {
        return 'conversational';
    }
    if (messageHasProgrammaticHandler(text)) {
        return 'programmatic';
    }
    if (
        userWantsDashboardReviewOnly(text) ||
        isDashboardDataInvestigationQuestion(text) ||
        (READ_ONLY_VERB.test(text) && !MUTATING_VERB.test(text))
    ) {
        return 'read_only';
    }
    if (userWantsPanelRemove(text, contextDashboardUid) || messageDescribesPanelRemove(text)) {
        return 'programmatic';
    }
    if (userWantsPanelRename(text) || messageDescribesPanelRename(text)) {
        return 'programmatic';
    }
    return 'mutating';
}

export function isReadOnlyLlmIntent(intent: LlmIntentKind): boolean {
    return intent === 'read_only';
}

export function llmIntentAllowsUpdateDashboard(intent: LlmIntentKind): boolean {
    return intent === 'mutating';
}
