import type { ToolExecution } from '../types/llm.types';
import { latestNonContinueUserMessage } from './dashboardCloneProgress';
import {
    applyOperatorFriendlyPanelCreateReply,
    userWantsPanelCreate,
} from './dashboardPanelCreateReply';
import { stripPanelIndexTables } from './dashboardTaskStatus';
import {
    describeDefaultSaveOutcome,
    extractSuccessLineFromModel,
    HARD_REFRESH_LINE,
    hasSuccessfulDashboardSave,
    resolveSavedDashboardLabel,
    savedVersionFromTools,
} from './dashboardSaveReplyUtils';

export { hasSuccessfulDashboardSave } from './dashboardSaveReplyUtils';

/** Any confirmed update_dashboard save — use concise Done block at end (except panel-fix / clone handlers). */
export function applyOperatorFriendlyDashboardSaveReply(
    content: string,
    toolExecutions: ToolExecution[],
    recentUserMessages: string[] = [],
    fallbackUserMessage = ''
): string {
    const latest = latestNonContinueUserMessage(recentUserMessages) ?? fallbackUserMessage.trim();

    if (userWantsPanelCreate(latest)) {
        return applyOperatorFriendlyPanelCreateReply(
            content,
            toolExecutions,
            recentUserMessages,
            fallbackUserMessage
        );
    }

    const stripped = stripPanelIndexTables(content);
    const dashboard = resolveSavedDashboardLabel(toolExecutions, latest, stripped);
    const version = savedVersionFromTools(toolExecutions);
    const versionBit = version ? ` (version **${version}**)` : '';
    const outcome =
        extractSuccessLineFromModel(stripped) ?? describeDefaultSaveOutcome(latest);

    return (
        `### Done (dashboard saved)\n\n` +
        `✅ ${outcome} on ${dashboard}${versionBit}.\n\n` +
        HARD_REFRESH_LINE
    );
}
