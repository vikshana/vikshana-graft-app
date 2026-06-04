import { evaluateMcpToolResult } from './toolResult';

export interface McpCallOutcome {
    ok: boolean;
    text: string;
    error?: string;
    summary?: string;
    userReference?: string;
}

/** Invoke a Grafana MCP tool from the plugin UI (same path as the LLM tool loop). */
export async function callMcpTool(
    mcpClient: { callTool: (req: { name: string; arguments: Record<string, unknown> }) => Promise<unknown> },
    toolName: string,
    args: Record<string, unknown>
): Promise<McpCallOutcome> {
    const result = await mcpClient.callTool({ name: toolName, arguments: args });
    const evaluated = evaluateMcpToolResult(toolName, result);
    return {
        ok: evaluated.ok,
        text: evaluated.text,
        error: evaluated.error,
        summary: evaluated.summary,
        userReference: evaluated.userReference,
    };
}

function tryParseJson(text: string): unknown | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        return null;
    }
    try {
        return JSON.parse(trimmed);
    } catch {
        return null;
    }
}

export function parseJsonFromMcpText(text: string): unknown | null {
    return tryParseJson(text);
}
