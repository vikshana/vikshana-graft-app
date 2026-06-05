import { llm } from '@grafana/llm';

// Import types from centralized location
import type { Message, ToolExecution } from '../types/llm.types';
import {
    assistantPromisesMorePanels,
    getIncompleteCloneProgress,
    resolveDashboardCloneIntent,
} from './dashboardCloneProgress';
import {
    buildForcedCloneContinueLlmMessage,
    countContinueMessages,
    getCloneSessionMeta,
} from './cloneSessionStorage';
import { assessCloneTask } from './dashboardTaskStatus';
import {
    assistantAskedPendingQuestion,
    buildContinuationFromPendingTask,
    getPendingDashboardTask,
} from './dashboardPendingTask';
import {
    appendRateLimitWaitNotice,
    isRateLimitError,
    stripLeakedToolCallMarkup,
    stripRateLimitWaitNotice,
    waitForRateLimitCooldown,
} from './chatError';
import {
    executeChunkedUpdateDashboard,
    formatChunkedUpdateForLlm,
    shouldChunkUpdateDashboardArgs,
} from './dashboardChunkedUpdate';
import { evaluateMcpToolResult, formatToolResultForLlm } from './toolResult';
import { extractDashboardFromGetByUid } from './programmaticDashboardClone';
import {
    commitRevertSnapshotAfterSave,
    setPendingRevertBaseline,
} from './dashboardRevertStorage';
import {
    buildForcedPanelFixContinueLlmMessage,
    parseScopedPanelFixRequest,
} from './panelFixScope';
import { applyPanelFixScopeEnforcement } from './panelFixEnforcement';
import {
    getPanelFixScope,
    setPanelFixBaseline,
    setPanelFixResolvedPanel,
} from './panelFixSessionStorage';
import { normalizeUpdateDashboardArgs } from './updateDashboardArgs';
import { resolvePanelForScopedFix } from './panelDiscovery';
import { tryInterceptRenameBeforeLlm } from './renameLlmGuard';
import { messageDescribesDashboardRename } from './dashboardRenameParse';
import { isSimpleConversationalMessage } from './programmaticChatIntents';
import { isExplicitSinglePanelCopyRequest } from './singlePanelCopyParse';

// Re-export types for backward compatibility
export type { ToolExecution };

/** Total MCP tool executions per user message (multi-panel edits need many steps). */
export const MAX_TOOL_STEPS = 60;

/** Extra LLM rounds when partially done (kept low to avoid Grafana LLM rate limits). */
export const MAX_AUTO_CONTINUE_ROUNDS = 4;

/** Pause between auto-continue LLM calls (ms) to reduce 429 rate-limit errors. */
export const AUTO_CONTINUE_DELAY_MS = 2500;

const CONTINUE_NOTICE =
    '\n\n---\n**Stopped after the maximum automated tool steps.** Reply **"Continue"** to finish the remaining work.';

const INCOMPLETE_CLONE_NOTICE =
    '\n\n---\n**Dashboard clone not finished.** Reply **"Continue"** to copy the remaining panels.';

const CONTINUATION_USER_MESSAGE =
    'Continue the task from where you stopped. Call tools immediately (get_dashboard_by_uid then update_dashboard as needed). ' +
    'Do not describe what you will do next — execute the remaining panel/dashboard updates now.';

const CLONE_CONTINUATION_SUFFIX =
    ' For machine dashboard clones: get_dashboard_by_uid(source template), replace machine (and related) labels in every target, ' +
    'then update_dashboard on the target uid (update the existing target-machine dashboard if search found one). ' +
    'Do not ask the user to pick option 1 vs 2 — proceed with the update.';

const DISCOVERY_TOOLS = new Set([
    'search_dashboards',
    'get_dashboard_summary',
    'get_dashboard_by_uid',
    'search_folders',
]);

/** User asked to change or create dashboard/panel content. */
export function userWantsDashboardWork(userContent: string): boolean {
    if (messageDescribesDashboardRename(userContent)) {
        return false;
    }
    return (
        /\b(update|modify|change|edit|fix|convert|add|create|clone|copy|duplicate|replicate)\b/i.test(userContent) &&
        /\b(panel|dashboard|chart|graph|visual)/i.test(userContent)
    );
}

export function buildContinuationUserMessage(
    userContent: string,
    toolExecutions: ToolExecution[] = [],
    recentUserMessages: string[] = []
): string {
    const fromPending = buildContinuationFromPendingTask('Continue');
    if (fromPending) {
        return fromPending;
    }

    const scoped =
        parseScopedPanelFixRequest(userContent) ??
        parseScopedPanelFixRequest(
            [...recentUserMessages].reverse().find((m) => !/^continue\.?$/i.test(m.trim())) ?? ''
        );
    if (scoped) {
        return buildForcedPanelFixContinueLlmMessage(scoped, toolExecutions);
    }

    const cloneIntent = resolveDashboardCloneIntent(recentUserMessages) ?? userContent;
    const meta = getCloneSessionMeta();
    const status = assessCloneTask(cloneIntent, toolExecutions, recentUserMessages);
    if (status?.state === 'not_started' || status?.state === 'stuck') {
        const m = meta ?? { intent: cloneIntent, continueAttempts: 0 };
        return buildForcedCloneContinueLlmMessage({ ...m, intent: cloneIntent });
    }
    const incomplete = getIncompleteCloneProgress(cloneIntent, toolExecutions, cloneIntent);
    if (incomplete) {
        const from = incomplete.targetPanels;
        const to = incomplete.sourcePanels - 1;
        return (
            CONTINUATION_USER_MESSAGE +
            ` Target uid=${incomplete.targetUid} has ${incomplete.targetPanels}/${incomplete.sourcePanels} panels. ` +
            `Copy panels arrayIndex ${from} through ${to} from source uid=${incomplete.sourceUid} ` +
            `(machine labels from the user's request). Call get_dashboard_by_uid on both if needed, then update_dashboard on the target. ` +
            `Do not print panel index tables or ask questions — save the next batch now.`
        );
    }
    if (/\b(visual copy|clone|copy of|new dashboard)\b/i.test(userContent)) {
        return CONTINUATION_USER_MESSAGE + CLONE_CONTINUATION_SUFFIX;
    }
    return CONTINUATION_USER_MESSAGE;
}

/** Model stopped before dashboard work the user requested is complete. */
export function needsDashboardContinueNudge(
    userContent: string,
    assistantContent: string,
    toolExecutions: ToolExecution[],
    recentUserMessages: string[] = []
): boolean {
    const intent =
        [...recentUserMessages].reverse().find((m) => !/^continue\.?$/i.test(m.trim())) ??
        userContent;
    const scoped = parseScopedPanelFixRequest(intent);
    if (scoped) {
        return !toolExecutions.some(
            (t) => t.name === 'update_dashboard' && t.status === 'success'
        );
    }

    const cloneIntent = resolveDashboardCloneIntent(recentUserMessages) ?? userContent;

    if (!userWantsDashboardWork(cloneIntent) && !userWantsDashboardWork(userContent)) {
        return false;
    }

    const cloneTask = assessCloneTask(cloneIntent, toolExecutions, recentUserMessages);
    if (cloneTask?.state === 'in_progress') {
        const have = cloneTask.targetPanels ?? 0;
        const total = cloneTask.sourcePanels ?? 0;
        const sameDashboard =
            cloneTask.sourceUid &&
            cloneTask.targetUid &&
            cloneTask.sourceUid === cloneTask.targetUid;
        const sameTitle =
            cloneTask.sourceTitle &&
            cloneTask.targetTitle &&
            cloneTask.sourceTitle.toLowerCase() === cloneTask.targetTitle.toLowerCase();
        if (total >= 3 && have >= total - 1 && (sameDashboard || sameTitle)) {
            return false;
        }
        return true;
    }

    if (getIncompleteCloneProgress(cloneIntent, toolExecutions, cloneIntent)) {
        return true;
    }

    const saved = toolExecutions.some((t) => t.name === 'update_dashboard' && t.status === 'success');
    if (saved && !assistantPromisesMorePanels(assistantContent)) {
        return false;
    }

    if (
        getPendingDashboardTask() &&
        assistantAskedPendingQuestion(assistantContent) &&
        !saved
    ) {
        return true;
    }

    const planningStop =
        /\b(I will|I'll|now I will|now I'll|I'll now|I will now|let me now|going to update|next I will)\b/i.test(
            assistantContent
        );
    const clarificationStop =
        /\b(Would you like|Which would you prefer|Please choose|Let me know which|Reply with \*\*Continue\*\*|option 1|option 2)\b/i.test(
            assistantContent
        );
    const hadDiscovery = toolExecutions.some(
        (t) => DISCOVERY_TOOLS.has(t.name) && t.status === 'success'
    );
    const lookupOnlyStop = hadDiscovery && !toolExecutions.some((t) => t.name === 'update_dashboard');
    const partialNarrationStop = saved && assistantPromisesMorePanels(assistantContent);
    const firstPassCloneLookup =
        cloneTask?.state === 'not_started' && lookupOnlyStop && countContinueMessages(recentUserMessages) === 0;

    return (
        planningStop ||
        clarificationStop ||
        lookupOnlyStop ||
        partialNarrationStop ||
        firstPassCloneLookup
    );
}

/** One-shot LLM call for casual chat — bypasses tools, context blob, and auto-continue loops. */
export async function runSimpleConversationalChat(
    userText: string,
    modelType: 'standard' | 'thinking' = 'standard',
    signal?: AbortSignal,
    onUpdate?: (content: string) => void
): Promise<string> {
    if (signal?.aborted) {
        throw new Error('Aborted');
    }
    const model = modelType === 'thinking' ? llm.Model.LARGE : llm.Model.BASE;
    const response = await llm.chatCompletions({
        model,
        messages: [
            {
                role: 'system',
                content:
                    'You are Graft, a helpful AI assistant embedded in Grafana. ' +
                    'Answer briefly and clearly.',
            },
            { role: 'user', content: userText },
        ],
    } as any);
    const text = response.choices?.[0]?.message?.content ?? '';
    onUpdate?.(text);
    return text;
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

        const lastUserRaw = [...validMessages].reverse().find((m) => m.role === 'user')?.content;
        const lastUserText = typeof lastUserRaw === 'string' ? lastUserRaw.trim() : '';
        const simpleTurn = isSimpleConversationalMessage(lastUserText);
        const effectiveTools = simpleTurn ? undefined : tools;
        const hasTools = Boolean(effectiveTools && effectiveTools.length > 0);

        let latestDisplayContent = '';
        let latestToolExecutions: ToolExecution[] = [];

        const trackedUpdate = (content: string, toolExecutions?: ToolExecution[]) => {
            latestDisplayContent = content;
            if (toolExecutions) {
                latestToolExecutions = toolExecutions;
            }
            onUpdate(content, toolExecutions);
        };

        if (isExplicitSinglePanelCopyRequest(lastUserText)) {
            const blocked =
                '### Single-panel copy only\n\n' +
                'This message copies **one panel** to another dashboard — not a full layout clone. ' +
                'Graft should handle it without the LLM clone path.\n\n' +
                '**What to do:** Hard-refresh (**Cmd+Shift+R**) so the chat badge shows the latest build, then send the same prompt again. ' +
                'You should see **Done — one panel copied**, not “36 of 41 panels”.';
            trackedUpdate(blocked, []);
            return blocked;
        }

        const renameIntercept = await tryInterceptRenameBeforeLlm(validMessages, mcpClient, trackedUpdate);
        if (renameIntercept !== null) {
            return stripLeakedToolCallMarkup(renameIntercept);
        }

        const callLlm = async () => {
            if (signal?.aborted) {
                throw new Error('Aborted');
            }
            const maxAttempts = 2;
            let lastError: unknown;
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                    return await llm.chatCompletions({
                        model,
                        messages: llmMessages,
                        tools: hasTools ? effectiveTools : undefined,
                    } as any);
                } catch (err) {
                    lastError = err;
                    if (!isRateLimitError(err) || attempt >= maxAttempts || signal?.aborted) {
                        throw err;
                    }
                    console.warn(
                        `[Graft] Rate limited (attempt ${attempt}/${maxAttempts}), waiting 60s then retrying`
                    );
                    await waitForRateLimitCooldown(signal, (remainingMs) => {
                        trackedUpdate(
                            appendRateLimitWaitNotice(latestDisplayContent, remainingMs),
                            latestToolExecutions
                        );
                    });
                }
            }
            throw lastError;
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
                trackedUpdate(fullContent, toolExecutions);

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
                    trackedUpdate(fullContent, toolExecutions);
                };

                try {
                    if (!mcpClient) {
                        throw new Error('MCP Client not available');
                    }

                    let args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;

                    if (toolName === 'update_dashboard') {
                        args = normalizeUpdateDashboardArgs(args);
                        args = applyPanelFixScopeEnforcement(args);
                    }

                    if (toolName === 'update_dashboard' && shouldChunkUpdateDashboardArgs(args)) {
                        toolExecutions.pop();
                        const chunked = await executeChunkedUpdateDashboard(
                            mcpClient,
                            args,
                            toolExecutions
                        );
                        for (const step of toolExecutions) {
                            if (step.name === 'update_dashboard' && !step.toolCallId) {
                                step.toolCallId = toolCallId;
                            }
                        }
                        trackedUpdate(fullContent, toolExecutions);

                        if (chunked.ok && chunked.uid) {
                            commitRevertSnapshotAfterSave(chunked.uid);
                        }

                        const llmContent = formatChunkedUpdateForLlm(chunked);
                        llmMessages.push({
                            role: 'tool',
                            content: chunked.ok
                                ? llmContent
                                : `Error: ${chunked.error ?? 'Chunked save failed'}\n\n${llmContent}`,
                            tool_call_id: toolCallId,
                        });
                    } else {
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
                            if (toolName === 'get_dashboard_by_uid') {
                                const uid = typeof args.uid === 'string' ? args.uid : '';
                                const extracted = extractDashboardFromGetByUid(evaluated.text);
                                if (extracted?.dashboard && uid) {
                                    const title =
                                        typeof extracted.dashboard.title === 'string'
                                            ? extracted.dashboard.title
                                            : undefined;
                                    setPendingRevertBaseline(uid, extracted.dashboard, title);

                                    const scope = getPanelFixScope();
                                    if (scope && uid === scope.dashboardUid) {
                                        setPanelFixBaseline(extracted.dashboard);
                                        const resolved = resolvePanelForScopedFix(
                                            extracted.dashboard,
                                            scope
                                        );
                                        if (resolved.ok) {
                                            setPanelFixResolvedPanel({
                                                panelId: resolved.resolved.entry.panelId,
                                                panelTitle: resolved.resolved.entry.title,
                                                panelArrayIndex: resolved.resolved.entry.arrayIndex,
                                            });
                                        }
                                    }
                                }
                            }
                            if (toolName === 'update_dashboard') {
                                const savedUid =
                                    typeof args.uid === 'string'
                                        ? args.uid
                                        : args.dashboard &&
                                            typeof args.dashboard === 'object' &&
                                            typeof (args.dashboard as { uid?: string }).uid ===
                                                'string'
                                          ? (args.dashboard as { uid: string }).uid
                                          : evaluated.summary?.match(/uid=([^\s,]+)/)?.[1];
                                if (savedUid) {
                                    commitRevertSnapshotAfterSave(savedUid);
                                }
                            }
                            updateToolExecution(
                                'success',
                                undefined,
                                evaluated.summary,
                                evaluated.userReference
                            );
                        } else {
                            updateToolExecution('error', evaluated.error ?? 'Tool returned an error');
                        }
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
                trackedUpdate(fullContent, toolExecutions);
            }

            if (simpleTurn) {
                return stripLeakedToolCallMarkup(stripRateLimitWaitNotice(fullContent));
            }

            let toolSteps = 0;
            let autoContinueRounds = 0;
            let hitStepLimit = false;
            const lastUserContent =
                [...validMessages].reverse().find((m) => m.role === 'user')?.content ?? '';
            const userMessageHistory = validMessages
                .filter((m) => m.role === 'user')
                .map((m) => (typeof m.content === 'string' ? m.content : String(m.content ?? '')));

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
                    trackedUpdate(fullContent, toolExecutions);
                }
            };

            outer: while (true) {
                await runToolLoop();

                const scopedFixActive =
                    getPanelFixScope() ?? parseScopedPanelFixRequest(lastUserContent);
                const scopedSaveFailed =
                    scopedFixActive &&
                    toolExecutions.some((t) => t.name === 'update_dashboard' && t.status === 'error') &&
                    !toolExecutions.some((t) => t.name === 'update_dashboard' && t.status === 'success');
                if (scopedSaveFailed) {
                    console.warn('[Graft] Scoped panel fix save failed — stopping auto-continue');
                    break outer;
                }

                const stepLimitPending = hitStepLimit && toolCalls && toolCalls.length > 0;
                const narrationStuck =
                    (!toolCalls || toolCalls.length === 0) &&
                    needsDashboardContinueNudge(
                        lastUserContent,
                        fullContent,
                        toolExecutions,
                        userMessageHistory
                    );

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

                    if (AUTO_CONTINUE_DELAY_MS > 0) {
                        await new Promise((r) => setTimeout(r, AUTO_CONTINUE_DELAY_MS));
                    }
                    if (signal?.aborted) {
                        throw new Error('Aborted');
                    }

                    llmMessages.push({
                        role: 'user',
                        content: buildContinuationUserMessage(
                            lastUserContent,
                            toolExecutions,
                            userMessageHistory
                        ),
                    });

                    const contResponse = await callLlm();
                    if (!contResponse.choices?.length) {
                        break outer;
                    }

                    const contChoice = contResponse.choices[0];
                    fullContent = contChoice.message?.content || fullContent;
                    toolCalls = contChoice.message?.tool_calls || [];
                    trackedUpdate(fullContent, toolExecutions);
                    continue outer;
                }

                break outer;
            }

            if (hitStepLimit && toolCalls && toolCalls.length > 0) {
                console.warn('[Graft] Max tool steps reached after auto-continue, stopping');
                if (!fullContent.includes(CONTINUE_NOTICE)) {
                    fullContent += CONTINUE_NOTICE;
                    trackedUpdate(fullContent, toolExecutions);
                }
            }

            return stripLeakedToolCallMarkup(stripRateLimitWaitNotice(fullContent));
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
