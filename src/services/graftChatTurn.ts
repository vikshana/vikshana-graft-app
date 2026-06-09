import type { Message, ToolExecution } from '../types/llm.types';
import { llmService } from './llm';
import {
    appendDashboardReferencesToReply,
    appendSaveVerificationWarning,
} from './appendToolReferences';
import { hasSuccessfulDashboardSave } from './continueAction';
import { isSimpleConversationalMessage } from './programmaticChatIntents';
import { truncateMessages } from './truncation';
import {
    formatPendingTaskContextBlock,
    recordPendingTaskAfterAssistantTurn,
} from './dashboardPendingTask';
import { buildIntentAwareLlmContext, getLlmIntentForMessage } from './llmContextBuilder';
import { buildDashboardDiscoveryContextBlock } from './llmDashboardDiscovery';
import { resetTurnDashboardBaseline } from './llmDashboardSnapshot';
import { isReadOnlyLlmIntent } from './llmIntentRouter';
import { verifyLlmDashboardSave } from './llmSaveVerification';
import { applyLlmVerifiedSaveReply } from './llmVerifiedSaveReply';
import { filterToolsForReadOnlyIntent } from './toolFilter';
import { extractDashboardUidFromMessage } from './dashboardMentionParse';
import { parsePanelRemoveRequest } from './panelRemoveParse';
import {
    formatPanelRemoveReply,
    runProgrammaticPanelRemove,
} from './programmaticPanelRemove';
import type { DashboardContext, DataSourceContext } from '../types/context.types';

export interface GraftChatTurnResult {
    displayContent: string;
    rawContent: string;
    toolExecutions: ToolExecution[];
    thinkingSeconds?: number;
}

export interface GraftChatTurnParams {
    conversationMessages: Message[];
    fallbackUserMessage: string;
    context: string;
    modelType: 'standard' | 'thinking';
    signal?: AbortSignal;
    mcpClient: unknown;
    mcpTools: unknown[];
    buildNumber: string | number;
    dashboard?: DashboardContext;
    dataSources?: DataSourceContext[];
    contextDashboardUid?: string;
    onStream?: (content: string, toolExecutions?: ToolExecution[], thinkingSeconds?: number) => void;
}

/** Run one full LLM turn (tools + operator-friendly reply formatting). */
export async function runGraftChatTurn(params: GraftChatTurnParams): Promise<GraftChatTurnResult> {
    const {
        conversationMessages,
        fallbackUserMessage,
        context,
        modelType,
        signal,
        mcpClient,
        mcpTools,
        buildNumber,
        dashboard,
        dataSources = [],
        contextDashboardUid,
        onStream,
    } = params;

    let finalContent = '';
    let finalToolExecutions: ToolExecution[] = [];
    let thinkingDuration: number | undefined;
    let thinkingStartTime: number | null = null;

    resetTurnDashboardBaseline();

    const truncatedMessages = truncateMessages(conversationMessages, 10);
    const intent = getLlmIntentForMessage(fallbackUserMessage, contextDashboardUid);

    let enrichedContext = context;
    if (dashboard) {
        enrichedContext = buildIntentAwareLlmContext(context, fallbackUserMessage, dashboard, dataSources);
    }
    enrichedContext += formatPendingTaskContextBlock();

    const uidForDiscovery =
        extractDashboardUidFromMessage(fallbackUserMessage) ?? contextDashboardUid ?? dashboard?.uid;
    if (
        mcpClient &&
        uidForDiscovery &&
        !isSimpleConversationalMessage(fallbackUserMessage) &&
        intent !== 'programmatic'
    ) {
        const discovery = await buildDashboardDiscoveryContextBlock(
            mcpClient as Parameters<typeof buildDashboardDiscoveryContextBlock>[0],
            uidForDiscovery
        );
        if (discovery) {
            enrichedContext += `\n\n${discovery}`;
        }
    }

    const effectiveTools = isReadOnlyLlmIntent(intent)
        ? filterToolsForReadOnlyIntent(mcpTools as Parameters<typeof filterToolsForReadOnlyIntent>[0])
        : mcpTools;

    await llmService.chat(
        truncatedMessages,
        enrichedContext,
        (fullContent, toolExecutions) => {
            finalContent = fullContent;
            finalToolExecutions = toolExecutions || [];

            const trimmedContent = fullContent.trimStart();
            if (trimmedContent.startsWith('<think>') && thinkingStartTime === null) {
                thinkingStartTime = Date.now();
            }
            if (
                fullContent.includes('</think>') &&
                thinkingStartTime !== null &&
                thinkingDuration === undefined
            ) {
                thinkingDuration = Math.floor((Date.now() - thinkingStartTime) / 1000);
            }

            onStream?.(fullContent, toolExecutions, thinkingDuration);
        },
        modelType,
        signal,
        mcpClient,
        effectiveTools
    );

    const recentUserTexts = conversationMessages
        .filter((m) => m.role === 'user')
        .map((m) => m.content);

    let displayContent = isSimpleConversationalMessage(fallbackUserMessage)
        ? finalContent
        : appendDashboardReferencesToReply(
              finalContent,
              finalToolExecutions,
              recentUserTexts,
              fallbackUserMessage,
              { skipGenericSaveReply: hasSuccessfulDashboardSave(finalToolExecutions) }
          );

    if (!isSimpleConversationalMessage(fallbackUserMessage)) {
        if (hasSuccessfulDashboardSave(finalToolExecutions) && mcpClient) {
            let verification = await verifyLlmDashboardSave(
                mcpClient as Parameters<typeof verifyLlmDashboardSave>[0],
                fallbackUserMessage,
                finalToolExecutions,
                contextDashboardUid ?? uidForDiscovery
            );
            if (!verification.verified && !verification.skipped) {
                const removeReq = parsePanelRemoveRequest(fallbackUserMessage, {
                    contextDashboardUid: contextDashboardUid ?? uidForDiscovery,
                });
                if (removeReq) {
                    const repaired = await runProgrammaticPanelRemove(
                        mcpClient as Parameters<typeof runProgrammaticPanelRemove>[0],
                        removeReq,
                        { contextDashboardUid: contextDashboardUid ?? uidForDiscovery }
                    );
                    if (repaired.ok) {
                        displayContent = formatPanelRemoveReply(repaired, Number(buildNumber));
                        finalToolExecutions = [...finalToolExecutions, ...repaired.toolExecutions];
                        verification = { verified: true, skipped: false, detail: 'Repaired via programmatic panel remove.' };
                    }
                }
            }
            if (!verification.skipped) {
                displayContent = applyLlmVerifiedSaveReply(
                    displayContent,
                    verification,
                    finalToolExecutions,
                    recentUserTexts,
                    fallbackUserMessage,
                    buildNumber
                );
            }
        } else {
            displayContent = appendSaveVerificationWarning(
                displayContent,
                finalToolExecutions,
                recentUserTexts,
                fallbackUserMessage
            );
        }
    }

    recordPendingTaskAfterAssistantTurn(
        fallbackUserMessage,
        finalContent,
        finalToolExecutions
    );

    return {
        displayContent,
        rawContent: finalContent,
        toolExecutions: finalToolExecutions,
        thinkingSeconds: thinkingDuration,
    };
}
