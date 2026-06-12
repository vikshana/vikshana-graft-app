import { llm } from '@grafana/llm';

// Import types from centralized location
import type { Message, ToolExecution } from '../types/llm.types';

// Re-export types for backward compatibility
export type { ToolExecution };

// Cap tool result size to prevent context overflow.
// ~4000 chars ≈ 1000 tokens — enough for the model to reason about results
// while leaving room for dashboard JSON generation.
const MAX_TOOL_RESULT_CHARS = 4000;

/**
 * Truncates MCP tool result content to stay within the token budget.
 *
 * MCP results are arrays of content blocks ({ type, text } | { type, data, ... }).
 * We truncate the `text` of each block in place so the returned value remains
 * valid, parseable JSON — the same shape the model expects for tool results.
 * The truncation notice is appended inside the text of the last block that
 * had content removed, so the model sees it in the natural reading position.
 */
function truncateToolResult(contentJson: string): string {
    if (contentJson.length <= MAX_TOOL_RESULT_CHARS) {
        return contentJson;
    }

    let blocks: any[];
    try {
        blocks = JSON.parse(contentJson);
    } catch {
        // Not valid JSON (shouldn't happen, but fall back to safe string truncation)
        const omittedChars = contentJson.length - MAX_TOOL_RESULT_CHARS;
        return contentJson.slice(0, MAX_TOOL_RESULT_CHARS) +
            `[truncated — ${omittedChars} chars omitted]`;
    }

    if (!Array.isArray(blocks)) {
        // Scalar JSON value — truncate the serialised form
        const omittedChars = contentJson.length - MAX_TOOL_RESULT_CHARS;
        return contentJson.slice(0, MAX_TOOL_RESULT_CHARS) +
            `[truncated — ${omittedChars} chars omitted]`;
    }

    let budget = MAX_TOOL_RESULT_CHARS;
    const result = blocks.map((block: any) => {
        if (typeof block?.text !== 'string' || budget <= 0) {
            return block;
        }
        if (block.text.length <= budget) {
            budget -= block.text.length;
            return block;
        }
        const kept = block.text.slice(0, budget);
        const omittedChars = block.text.length - budget;
        budget = 0;
        return {
            ...block,
            text: `${kept}[truncated — ${omittedChars} chars omitted. Narrow the query if more detail is needed.]`,
        };
    });

    return JSON.stringify(result);
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
                const MAX_ITERATIONS = 10;
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

                                llmMessages.push({
                                    role: 'tool',
                                    content: truncateToolResult(JSON.stringify(result.content)),
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
