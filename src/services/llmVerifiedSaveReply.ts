import type { ToolExecution } from '../types/llm.types';
import type { LlmSaveVerification } from './llmSaveVerification';
import {
    describeDefaultSaveOutcome,
    extractSuccessLineFromModel,
    HARD_REFRESH_LINE,
    resolveSavedDashboardLabel,
    savedVersionFromTools,
} from './dashboardSaveReplyUtils';
import { stripPanelIndexTables } from './dashboardTaskStatus';
import { messageDescribesPanelRemove, userWantsPanelRemove } from './panelRemoveParse';
import { messageDescribesPanelRename, userWantsPanelRename } from './panelRenameParse';

export function applyLlmVerifiedSaveReply(
    content: string,
    verification: LlmSaveVerification,
    toolExecutions: ToolExecution[],
    recentUserMessages: string[] = [],
    fallbackUserMessage = '',
    buildNumber: string | number
): string {
    const latestUser =
        [...recentUserMessages].reverse().find((m) => !/^continue\.?$/i.test(m.trim())) ??
        fallbackUserMessage.trim();

    if (userWantsPanelRename(latestUser) || messageDescribesPanelRename(latestUser)) {
        return content;
    }
    if (userWantsPanelRemove(latestUser) || messageDescribesPanelRemove(latestUser)) {
        return content;
    }

    const stripped = stripPanelIndexTables(content);
    const dashboard = resolveSavedDashboardLabel(toolExecutions, latestUser, stripped);
    const version = verification.version ?? savedVersionFromTools(toolExecutions);
    const versionBit = version ? ` (version **${version}**)` : '';

    if (!verification.verified && !verification.skipped) {
        return (
            `### Save not verified (LLM · build ${buildNumber})\n\n` +
            `⚠️ ${verification.detail ?? 'Dashboard save could not be verified.'}\n` +
            `- ${dashboard}${versionBit}\n\n` +
            `Hard-refresh and check the dashboard. Retry with a more specific prompt or use a programmatic handler.\n`
        );
    }

    const outcome = extractSuccessLineFromModel(stripped) ?? describeDefaultSaveOutcome(latestUser);
    return (
        `### Dashboard saved (LLM verified · build ${buildNumber})\n\n` +
        `✅ ${outcome} on ${dashboard}${versionBit}.\n` +
        (verification.detail ? `- ${verification.detail}\n` : '') +
        `\n${HARD_REFRESH_LINE}`
    );
}
