import { llm } from '@grafana/llm';

// Import types from centralized location
import type { Message, ToolExecution } from '../types/llm.types';

// Re-export types for backward compatibility
export type { ToolExecution };

const SETTINGS_PATH = '/plugins/vikshana-graft-app';
const DEFAULT_MAX_ITERATIONS = 10;

/** findLastIndex polyfill — Array.prototype.findLastIndex requires ES2023 */
function findLastIndex<T>(arr: T[], predicate: (item: T) => boolean): number {
    for (let i = arr.length - 1; i >= 0; i--) {
        if (predicate(arr[i])) { return i; }
    }
    return -1;
}

export const llmService = {
    async chat(
        messages: Message[],
        context: any,
        onUpdate: (content: string, toolExecutions?: ToolExecution[]) => void,
        modelType: 'standard' | 'thinking' = 'standard',
        signal?: AbortSignal,
        mcpClient?: any,
        tools?: any[],
        maxToolIterations: number = DEFAULT_MAX_ITERATIONS
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

                // Agent loop for tool calls with configurable max iterations
                let iteration = 0;

                while (toolCalls && toolCalls.length > 0 && iteration < maxToolIterations) {
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

                        // Add pending tool execution
                        toolExecutions.push({
                            name: toolCall.function.name,
                            status: 'pending'
                        });
                        onUpdate(fullContent, toolExecutions);

                        try {
                            if (!mcpClient) {
                                throw new Error('MCP Client not available');
                            }

                            const args = JSON.parse(toolCall.function.arguments);
                            const result = await mcpClient.callTool({
                                name: toolCall.function.name,
                                arguments: args,
                            });

                            // Store the full result — no truncation
                            llmMessages.push({
                                role: 'tool',
                                content: JSON.stringify(result.content),
                                tool_call_id: toolCall.id,
                            });

                            // Update tool execution to success
                            const toolExecIndex = toolExecutions.findIndex(
                                t => t.name === toolCall.function.name && t.status === 'pending'
                            );
                            if (toolExecIndex !== -1) {
                                toolExecutions[toolExecIndex].status = 'success';
                            }
                            onUpdate(fullContent, toolExecutions);
                        } catch (error: any) {
                            console.error(`[Graft] Tool execution failed: ${error.message}`);
                            llmMessages.push({
                                role: 'tool',
                                content: `Error executing ${toolCall.function.name}: ${error.message}`,
                                tool_call_id: toolCall.id,
                            });

                            // Update tool execution to error
                            const toolExecIndex = toolExecutions.findIndex(
                                t => t.name === toolCall.function.name && t.status === 'pending'
                            );
                            if (toolExecIndex !== -1) {
                                toolExecutions[toolExecIndex].status = 'error';
                                toolExecutions[toolExecIndex].error = error.message;
                            }
                            onUpdate(fullContent, toolExecutions);
                        }
                    }

                    // Compress prior tool results before the next LLM call to manage
                    // context window growth. Dashboard-related tools whose results must
                    // be passed verbatim to the next call (e.g. get_dashboard_by_uid →
                    // update_dashboard) are excluded from compression.
                    const NO_COMPRESS = new Set([
                        'get_dashboard_by_uid',
                        'get_dashboard_panel_queries',
                        'get_dashboard_property',
                        'get_dashboard_summary',
                        'update_dashboard',
                    ]);
                    for (const toolCall of toolCalls) {
                        if (NO_COMPRESS.has(toolCall.function.name)) { continue; }
                        const msgIdx = findLastIndex(
                            llmMessages,
                            (m: llm.Message) => (m as any).tool_call_id === toolCall.id
                        );
                        if (msgIdx !== -1) {
                            const original = (llmMessages[msgIdx] as any).content as string;
                            const preview = original.length > 200 ? original.slice(0, 200) + '...' : original;
                            (llmMessages[msgIdx] as any).content =
                                `[${toolCall.function.name} result processed — summary: ${preview}]`;
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

                if (iteration >= maxToolIterations) {
                    console.warn('[Graft] Max tool calling iterations reached, stopping');
                    fullContent += `\n\n> **Note:** The maximum number of tool call steps (${maxToolIterations}) was reached and this response may be incomplete. Try breaking your request into smaller steps, or increase the limit in the Graft plugin settings at ${SETTINGS_PATH}.`;
                    onUpdate(fullContent, toolExecutions);
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
