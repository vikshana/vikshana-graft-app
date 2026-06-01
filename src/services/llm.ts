import { llm } from '@grafana/llm';

// Import types from centralized location
import type { Message, ToolExecution } from '../types/llm.types';
import { evaluateMcpToolResult, formatToolResultForLlm } from './toolResult';

// Re-export types for backward compatibility
export type { ToolExecution };

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
        const validMessages = messages.filter(m =>
            !(m.role === 'assistant' && !m.content && !m.tool_calls?.length)
        );

        // Map internal messages to llm.Message
        const llmMessages: llm.Message[] = validMessages.map(m => {
            const msg: any = {
                role: m.role,
            };

            let content: any[] = [{ type: 'text', text: m.content }];

            // Handle attachments
            if (m.attachments && m.attachments.length > 0) {
                m.attachments.forEach(att => {
                    if (att.type === 'image') {
                        const mimeType = att.mimeType || 'image/jpeg';
                        content.push({
                            type: 'image_url',
                            image_url: {
                                url: att.content.startsWith('data:') ? att.content : `data:${mimeType};base64,${att.content}`,
                            },
                        });
                    } else if (att.type === 'text') {
                        // Append text attachment content to the text message
                        // We do this by modifying the first text block or adding a new one
                        const textBlock = content.find(c => c.type === 'text');
                        if (textBlock) {
                            textBlock.text += `\n\n[Attached File: ${att.name}]\n\`\`\`\n${att.content}\n\`\`\``;
                        } else {
                            content.push({
                                type: 'text',
                                text: `\n\n[Attached File: ${att.name}]\n\`\`\`\n${att.content}\n\`\`\``
                            });
                        }
                    }
                });
            }

            // If we have mixed content (images/attachments), use the array format
            // Otherwise just use string content if it's simple text
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
            const systemMsgIndex = llmMessages.findIndex(m => m.role === 'system');
            if (systemMsgIndex >= 0) {
                llmMessages[systemMsgIndex].content += `\n\nContext:\n${context}`;
            } else {
                llmMessages.unshift({
                    role: 'system',
                    content: `Context:\n${context}`,
                });
            }
        }

        try {
            const response = await llm.chatCompletions({
                model: modelType === 'thinking' ? llm.Model.LARGE : llm.Model.BASE,
                messages: llmMessages,
                tools: tools && tools.length > 0 ? tools : undefined,
            } as any);

            // Check if response has tool calls
            if (response.choices && response.choices.length > 0) {
                const choice = response.choices[0];
                let fullContent = choice.message?.content || '';
                let toolCalls = choice.message?.tool_calls || [];
                const toolExecutions: ToolExecution[] = [];

                // Update UI with initial content
                if (fullContent) {
                    onUpdate(fullContent, toolExecutions);
                }

                // Agent loop for tool calls with max iterations to prevent infinite loops
                const MAX_ITERATIONS = 15;
                let iteration = 0;

                while (toolCalls && toolCalls.length > 0 && iteration < MAX_ITERATIONS) {
                    // Check if aborted
                    if (signal?.aborted) {
                        throw new Error('Aborted');
                    }

                    iteration++;

                    // Add assistant message with tool calls
                    llmMessages.push({
                        role: 'assistant',
                        content: fullContent,
                        tool_calls: toolCalls,
                    });

                        // Execute tools
                        for (const toolCall of toolCalls) {
                            // Check abort signal before each tool
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
                                summary?: string
                            ) => {
                                const toolExecIndex = toolExecutions.findIndex(
                                    t => t.toolCallId === toolCallId || (t.name === toolName && t.status === 'pending')
                                );
                                if (toolExecIndex !== -1) {
                                    toolExecutions[toolExecIndex].status = status;
                                    toolExecutions[toolExecIndex].error = error;
                                    toolExecutions[toolExecIndex].summary = summary;
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
                                    updateToolExecution('success', undefined, evaluated.summary);
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

                    // Check abort signal before next LLM call
                    if (signal?.aborted) {
                        throw new Error('Aborted');
                    }

                    // Make next request
                    const nextResponse = await llm.chatCompletions({
                        model: modelType === 'thinking' ? llm.Model.LARGE : llm.Model.BASE,
                        messages: llmMessages,
                        tools: tools && tools.length > 0 ? tools : undefined,
                    } as any);

                    if (nextResponse.choices && nextResponse.choices.length > 0) {
                        const nextChoice = nextResponse.choices[0];
                        fullContent = nextChoice.message?.content || fullContent;
                        toolCalls = nextChoice.message?.tool_calls || [];

                        onUpdate(fullContent, toolExecutions);
                    } else {
                        break;
                    }
                }

                if (iteration >= MAX_ITERATIONS) {
                    console.warn('[Graft] Max tool calling iterations reached, stopping');
                    const continueNotice =
                        '\n\n---\n**Stopped after the maximum automated tool steps.** Reply **"Continue"** to finish the remaining work.';
                    if (!fullContent.includes(continueNotice)) {
                        fullContent += continueNotice;
                        onUpdate(fullContent, toolExecutions);
                    }
                }

                return fullContent;
            } else {
                throw new Error('No choices in response');
            }

        } catch (error: any) {
            console.error('[Graft] Chat Error:', error);
            console.error('[Graft] Error details:', {
                name: error.name,
                message: error.message,
                stack: error.stack
            });
            throw error;
        }
    },
};
