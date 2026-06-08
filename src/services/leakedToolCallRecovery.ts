import { callMcpTool } from './mcpToolClient';
import type { ToolExecution } from '../types/llm.types';

export interface LeakedToolCall {
    name: string;
    args: Record<string, unknown>;
}

const INVOKE_RE =
    /<invoke\s+name="([^"]+)"\s*>([\s\S]*?)(?:<\/invoke>|$)/gi;

const PARAM_RE = /<parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/parameter>/gi;

/** Parse XML-style tool markup some models emit in plain text instead of native tool_calls. */
export function parseLeakedToolCalls(content: string): LeakedToolCall[] {
    const calls: LeakedToolCall[] = [];
    for (const invokeMatch of content.matchAll(INVOKE_RE)) {
        const name = invokeMatch[1]?.trim();
        if (!name) {
            continue;
        }
        const body = invokeMatch[2] ?? '';
        const args: Record<string, unknown> = {};
        for (const paramMatch of body.matchAll(PARAM_RE)) {
            const key = paramMatch[1]?.trim();
            const value = paramMatch[2]?.trim();
            if (key) {
                args[key] = value ?? '';
            }
        }
        calls.push({ name, args });
    }
    return calls;
}

export function contentHasLeakedToolCalls(content: string): boolean {
    return /<invoke\s+name="/i.test(content);
}

/**
 * Execute leaked tool markup via MCP when the model failed to use native tool_calls.
 */
export async function executeLeakedToolCalls(
    mcpClient: { callTool: (req: { name: string; arguments: Record<string, unknown> }) => Promise<unknown> },
    content: string
): Promise<{ toolExecutions: ToolExecution[]; executed: number; resultText: string }> {
    const calls = parseLeakedToolCalls(content);
    const toolExecutions: ToolExecution[] = [];
    const parts: string[] = [];

    for (const call of calls) {
        const step: ToolExecution = { name: call.name, status: 'pending' };
        toolExecutions.push(step);
        const outcome = await callMcpTool(mcpClient, call.name, call.args);
        step.status = outcome.ok ? 'success' : 'error';
        step.error = outcome.error;
        step.summary = outcome.summary;
        parts.push(`[${call.name}] ${outcome.ok ? 'ok' : 'error'}: ${outcome.text.slice(0, 2000)}`);
    }

    return {
        toolExecutions,
        executed: calls.length,
        resultText: parts.join('\n\n'),
    };
}
