import { llm } from '@grafana/llm';

// Import types from centralized location
import type { Message, ToolExecution } from '../types/llm.types';
import { evaluateMcpToolResult, formatToolResultForLlm } from './toolResult';

// Re-export types for backward compatibility
export type { ToolExecution };

/** Total MCP tool executions per user message (multi-panel edits need many steps). */
export const MAX_TOOL_STEPS = 40;

/** Extra LLM rounds when the step limit or a narration-only stop is detected. */
export const MAX_AUTO_CONTINUE_ROUNDS = 2;

const CONTINUE_NOTICE =
    '\n\n---\n**Stopped after the maximum automated tool steps.** Reply **"Continue"** to finish the remaining work.';

const CONTINUATION_USER_MESSAGE =
    'Continue the task from where you stopped. Call tools immediately (get_dashboard_by_uid then update_dashboard as needed). ' +
    'Do not describe what you will do next — execute the remaining panel/dashboard updates now.';

/** Model stopped with planning text but never saved the dashboard. */
export function needsDashboardContinueNudge(
    userContent: string,
    assistantContent: string,
    toolExecutions: ToolExecution[]
): boolean {
    const userWantsEdit =
        /\b(update|modify|change|edit|fix|convert|add)\b/i.test(userContent) &&
        /\b(panel|dashboard|chart|graph)/i.test(userContent);
    const saved = toolExecutions.some((t) => t.name === 'update_dashboard' && t.status === 'success');
    const planningStop =
        /\b(I will|I'll|now I will|now I'll|let me now|going to update|next I will)\b/i.test(assistantContent);
    return userWantsEdit && !saved && planningStop;
}

export const llmService = {
    async chat(
        messages: Message[],
        context: any,
        onUpdate: (content: string, toolExecutions?: ToolExecution[]) => void,
        modelType: 'standard' | 'thinking' = 'standard',
        signal?: AbortSignal,
        mcpClient?: any,
        tools?: any[]
    ): Promise<string> {
        // Filter out assistant messages with no content and no tool_calls (e.g. placeholder messages)
        const validMessages = messages.filter(
            (m) => !(m.role === 'assistant' && !m.content && !m.tool_calls?.length)
        );

        // Map internal messages to llm.Message
        const llmMessages: llm.Message[] = validMessages.map((m) => {
            const msg: any = {
                role: m.role,
            };

            const content: any[] = [{ type: 'text', text: m.content }];

            // Handle attachments
            if (m.attachments && m.attachments.length > 0) {
                m.attachments.forEach((att) => {
                    if (att.type === 'image') {
                        const mimeType = att.mimeType || 'image/jpeg';
                        content.push({
                            type: 'image_url',
                            image_url: {
                                url: att.content.startsWith('data:')
                                    ? att.content
                                    : `data:${mimeType};base64,${att.content}`,
                            },
                        });
                    } else if (att.type === 'text') {
                        const textBlock = content.find((c) => c.type === 'text');
                        if (textBlock) {
                            textBlock.text += `\n\n[Attached File: ${att.name}]\n\`\`\`\n${att.content}\n\`\`\``;
                        } else {
                            content.push({
                                type: 'text',
                                text: `\n\n[Attached File: ${att.name}]\n\`\`\`\n${att.content}\n\`\`\``,
                            });
                        }
                    }
                });
            }

            if (content.length > 1 || (content.length === 1 && content[0].type !== 'text')) {
                msg.content = content;
            } else {
                msg.content = content[0].text;
            }

            if (m.tool_call_id) {
                msg.tool_call_id = m.tool_call_id;
            }
            if (m.tool_calls) {
                msg.tool_calls = m.tool_calls;
            }
            return msg;
        });

        // Add context as system message if provided
        if (context) {
            const systemMsgIndex = llmMessages.findIndex((m) => m.role === 'system');
            if (systemMsgIndex >= 0) {
                llmMessages[systemMsgIndex].content += `\n\nContext:\n${context}`;
            } else {
                llmMessages.unshift({
                    role: 'system',
                    content: `Context:\n${context}`,
                });
            }
        }

        const model = modelType === 'thinking' ? llm.Model.LARGE : llm.Model.BASE;
        const hasTools = Boolean(tools && tools.length > 0);

        const callLlm = async () => {
            if (signal?.aborted) {
                throw new Error('Aborted');
            }
            return llm.chatCompletions({
                model,
                messages: llmMessages,
                tools: hasTools ? tools : undefined,
            } as any);
        };

        const executeToolBatch = async (
            toolCalls: any[],
            fullContent: string,
            toolExecutions: ToolExecution[]
        ): Promise<string> => {
            for (const toolCall of toolCalls) {
                if (signal?.aborted) {
                    throw new Error('Aborted');
                }

                const toolName = toolCall.function.name;
                const toolCallId = toolCall.id;

                toolExecutions.push({
                    name: toolName,
                    status: 'pending',
                    toolCallId,
                });
                onUpdate(fullContent, toolExecutions);

                const updateToolExecution = (
                    status: ToolExecution['status'],
                    error?: string,
                    summary?: string,
                    userReference?: string
                ) => {
                    const toolExecIndex = toolExecutions.findIndex(
                        (t) => t.toolCallId === toolCallId || (t.name === toolName && t.status === 'pending')
                    );
                    if (toolExecIndex !== -1) {
                        toolExecutions[toolExecIndex].status = status;
                        toolExecutions[toolExecIndex].error = error;
                        toolExecutions[toolExecIndex].summary = summary;
                        if (userReference) {
                            toolExecutions[toolExecIndex].userReference = userReference;
                        }
                    }
                    onUpdate(fullContent, toolExecutions);
                };

                try {
                    if (!mcpClient) {
                        throw new Error('MCP Client not available');
                    }

                    const args = JSON.parse(toolCall.function.arguments);
                    const result = await mcpClient.callTool({
                        name: toolName,
                        arguments: args,
                    });

                    const evaluated = evaluateMcpToolResult(toolName, result);
                    const llmContent = formatToolResultForLlm(toolName, evaluated.text);

                    llmMessages.push({
                        role: 'tool',
                        content: evaluated.ok
                            ? llmContent
                            : `Error: ${evaluated.error ?? 'Tool failed'}\n\n${llmContent}`,
                        tool_call_id: toolCallId,
                    });

                    if (evaluated.ok) {
                        updateToolExecution(
                            'success',
                            undefined,
                            evaluated.summary,
                            evaluated.userReference
                        );
                    } else {
                        updateToolExecution('error', evaluated.error ?? 'Tool returned an error');
                    }
                } catch (error: any) {
                    console.error(`[Graft] Tool execution failed: ${error.message}`);
                    llmMessages.push({
                        role: 'tool',
                        content: `Error executing ${toolName}: ${error.message}`,
                        tool_call_id: toolCallId,
                    });
                    updateToolExecution('error', error.message);
                }
            }
            return fullContent;
        };

        try {
            const response = await callLlm();

            if (!response.choices?.length) {
                throw new Error('No choices in response');
            }

            const choice = response.choices[0];
            let fullContent = choice.message?.content || '';
            let toolCalls = choice.message?.tool_calls || [];
            const toolExecutions: ToolExecution[] = [];

            if (fullContent) {
                onUpdate(fullContent, toolExecutions);
            }

            let toolSteps = 0;
            let autoContinueRounds = 0;
            let hitStepLimit = false;
            const lastUserContent =
                [...validMessages].reverse().find((m) => m.role === 'user')?.content ?? '';

            const runToolLoop = async (): Promise<void> => {
                while (toolCalls && toolCalls.length > 0) {
                    if (signal?.aborted) {
                        throw new Error('Aborted');
                    }

                    if (toolSteps >= MAX_TOOL_STEPS) {
                        hitStepLimit = true;
                        return;
                    }

                    llmMessages.push({
                        role: 'assistant',
                        content: fullContent,
                        tool_calls: toolCalls,
                    });

                    await executeToolBatch(toolCalls, fullContent, toolExecutions);
                    toolSteps += toolCalls.length;

                    if (signal?.aborted) {
                        throw new Error('Aborted');
                    }

                    const nextResponse = await callLlm();
                    if (!nextResponse.choices?.length) {
                        toolCalls = [];
                        return;
                    }

                    const nextChoice = nextResponse.choices[0];
                    fullContent = nextChoice.message?.content || fullContent;
                    toolCalls = nextChoice.message?.tool_calls || [];
                    onUpdate(fullContent, toolExecutions);
                }
            };

            outer: while (true) {
                await runToolLoop();

                const stepLimitPending = hitStepLimit && toolCalls && toolCalls.length > 0;
                const narrationStuck =
                    (!toolCalls || toolCalls.length === 0) &&
                    needsDashboardContinueNudge(lastUserContent, fullContent, toolExecutions);

                if (
                    (stepLimitPending || narrationStuck) &&
                    autoContinueRounds < MAX_AUTO_CONTINUE_ROUNDS &&
                    hasTools
                ) {
                    autoContinueRounds++;
                    hitStepLimit = false;
                    toolSteps = 0;
                    console.info(
                        `[Graft] Auto-continuing (${autoContinueRounds}/${MAX_AUTO_CONTINUE_ROUNDS}): ${
                            stepLimitPending ? 'step limit' : 'narration stop'
                        }`
                    );

                    llmMessages.push({
                        role: 'user',
                        content: CONTINUATION_USER_MESSAGE,
                    });

                    const contResponse = await callLlm();
                    if (!contResponse.choices?.length) {
                        break outer;
                    }

                    const contChoice = contResponse.choices[0];
                    fullContent = contChoice.message?.content || fullContent;
                    toolCalls = contChoice.message?.tool_calls || [];
                    onUpdate(fullContent, toolExecutions);
                    continue outer;
                }

                break outer;
            }

            if (hitStepLimit && toolCalls && toolCalls.length > 0) {
                console.warn('[Graft] Max tool steps reached after auto-continue, stopping');
                if (!fullContent.includes(CONTINUE_NOTICE)) {
                    fullContent += CONTINUE_NOTICE;
                    onUpdate(fullContent, toolExecutions);
                }
            }

            return fullContent;
        } catch (error: any) {
            console.error('[Graft] Chat Error:', error);
            console.error('[Graft] Error details:', {
                name: error.name,
                message: error.message,
                stack: error.stack,
            });
            throw error;
        }
    },
};
