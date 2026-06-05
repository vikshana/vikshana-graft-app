import type { Message, ToolExecution } from '../types/llm.types';
import { llmService } from './llm';
import {
    appendDashboardReferencesToReply,
    appendSaveVerificationWarning,
} from './appendToolReferences';
import { isSimpleConversationalMessage } from './programmaticChatIntents';
import { truncateMessages } from './truncation';
import {
    formatPendingTaskContextBlock,
    recordPendingTaskAfterAssistantTurn,
} from './dashboardPendingTask';

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
        onStream,
    } = params;

    let finalContent = '';
    let finalToolExecutions: ToolExecution[] = [];
    let thinkingDuration: number | undefined;
    let thinkingStartTime: number | null = null;

    const truncatedMessages = truncateMessages(conversationMessages, 10);
    const enrichedContext = `${context}${formatPendingTaskContextBlock()}`;

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
        mcpTools
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
              fallbackUserMessage
          );

    if (!isSimpleConversationalMessage(fallbackUserMessage)) {
        displayContent = appendSaveVerificationWarning(
            displayContent,
            finalToolExecutions,
            recentUserTexts,
            fallbackUserMessage
        );
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
