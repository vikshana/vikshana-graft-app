import {
    enrichDashboardToolResult,
    getDashboardUserReference,
    summarizeDashboardTool,
} from './dashboardReference';

/** Default cap for most MCP tool results sent back to the LLM */
const MAX_TOOL_RESULT_CHARS = 4000;

/** Larger cap for dashboard read/write tools (full JSON is required to save correctly) */
const MAX_DASHBOARD_TOOL_RESULT_CHARS = 100000;

const DASHBOARD_TOOLS = new Set([
    'get_dashboard_by_uid',
    'get_dashboard_summary',
    'get_dashboard_panel_queries',
    'get_dashboard_property',
    'update_dashboard',
]);

function extractTextContent(result: unknown): string {
    if (!result || typeof result !== 'object') {
        return String(result ?? '');
    }

    const r = result as Record<string, unknown>;

    if (typeof r.message === 'string') {
        return r.message;
    }

    if (Array.isArray(r.content)) {
        return r.content
            .map((block) => {
                if (block && typeof block === 'object' && 'text' in block) {
                    return String((block as { text?: string }).text ?? '');
                }
                return typeof block === 'string' ? block : JSON.stringify(block);
            })
            .join('\n');
    }

    return JSON.stringify(result);
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

/**
 * Detect Grafana / MCP failures that do not throw from callTool().
 */
export function evaluateMcpToolResult(
    toolName: string,
    result: unknown
): { ok: boolean; text: string; error?: string; summary?: string; userReference?: string } {
    if (result && typeof result === 'object' && (result as { isError?: boolean }).isError === true) {
        const text = extractTextContent(result);
        return { ok: false, text, error: text || 'Tool returned isError' };
    }

    const text = extractTextContent(result);
    const parsed = tryParseJson(text);

    if (parsed && typeof parsed === 'object' && parsed !== null) {
        const obj = parsed as Record<string, unknown>;

        if (obj.status === 'error' || obj.status === 'failed') {
            const msg = String(obj.message ?? obj.error ?? text);
            return { ok: false, text, error: msg };
        }

        if (toolName === 'update_dashboard') {
            const uid = obj.uid ?? (obj.dashboard as Record<string, unknown> | undefined)?.uid;
            const version = obj.version ?? (obj.dashboard as Record<string, unknown> | undefined)?.version;
            if (!uid && !version) {
                return {
                    ok: false,
                    text,
                    error:
                        'update_dashboard did not return uid/version — dashboard was likely not saved. Fetch with get_dashboard_by_uid and retry.',
                };
            }
            const summary = uid
                ? `Saved dashboard uid=${uid}${version != null ? `, version=${version}` : ''}`
                : undefined;
            return { ok: true, text, summary };
        }
    }

    const userReference = getDashboardUserReference(toolName, text);
    const dashboardSummary = summarizeDashboardTool(toolName, text);
    if (dashboardSummary || userReference) {
        return { ok: true, text, summary: dashboardSummary, userReference };
    }

    const lower = text.toLowerCase();
    if (
        lower.includes('permission denied') ||
        lower.includes('unauthorized') ||
        lower.includes('access denied') ||
        lower.includes('not found')
    ) {
        return { ok: false, text, error: text.slice(0, 500) };
    }

    return { ok: true, text };
}

export function formatToolResultForLlm(toolName: string, text: string): string {
    let enriched = enrichDashboardToolResult(toolName, text);

    const maxChars = DASHBOARD_TOOLS.has(toolName)
        ? MAX_DASHBOARD_TOOL_RESULT_CHARS
        : MAX_TOOL_RESULT_CHARS;

    if (enriched.length <= maxChars) {
        return enriched;
    }

    const textToTruncate = enriched;

    const truncated = textToTruncate.slice(0, maxChars);
    const omittedChars = textToTruncate.length - maxChars;
    return `${truncated}\n...[truncated — ${omittedChars} characters omitted. For dashboards, use get_dashboard_property for specific fields if needed.]`;
}
