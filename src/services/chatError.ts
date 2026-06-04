/** Extract a human-readable message from Grafana LLM / fetch errors. */
export function extractErrorMessage(error: unknown): string {
    if (!error) {
        return 'Unknown error';
    }
    if (typeof error === 'string') {
        return error;
    }
    const e = error as Record<string, unknown>;
    if (typeof e.message === 'string' && e.message.trim()) {
        return e.message;
    }
    const data = e.data as Record<string, unknown> | undefined;
    if (typeof data?.message === 'string' && data.message.trim()) {
        return data.message;
    }
    if (typeof data?.error === 'string' && data.error.trim()) {
        return data.error;
    }
    const response = e.response as Record<string, unknown> | undefined;
    const responseData = response?.data as Record<string, unknown> | undefined;
    if (typeof responseData?.message === 'string') {
        return responseData.message;
    }
    if (typeof responseData?.error === 'string') {
        return responseData.error;
    }
    try {
        const serialized = JSON.stringify(error);
        if (serialized && serialized !== '{}') {
            return serialized.slice(0, 500);
        }
    } catch {
        // ignore
    }
    return 'Unknown error';
}

export function isRateLimitError(error: unknown): boolean {
    const msg = extractErrorMessage(error).toLowerCase();
    const e = error as { status?: number; statusCode?: number } | undefined;
    const status = e?.status ?? e?.statusCode;
    return (
        status === 429 ||
        msg.includes('too many request') ||
        msg.includes('rate limit') ||
        msg.includes('requests per minute') ||
        msg.includes('request per minute') ||
        msg.includes('per minute') ||
        msg.includes('429')
    );
}

/** Wait after Grafana LLM returns 429 / too-many-requests-per-minute. */
export const RATE_LIMIT_RETRY_WAIT_MS = 60_000;

export function rateLimitWaitNotice(remainingMs = RATE_LIMIT_RETRY_WAIT_MS): string {
    const secs = Math.max(1, Math.ceil(remainingMs / 1000));
    return (
        `---\n**AI rate limit** — Grafana allows only so many AI requests per minute. ` +
        `Waiting **${secs} second${secs === 1 ? '' : 's'}**, then Graft will **continue automatically**…`
    );
}

export function stripRateLimitWaitNotice(content: string): string {
    return content.replace(/\n\n---\n\*\*AI rate limit[\s\S]*$/i, '').trimEnd();
}

/** Some models emit XML-style tool markup in plain text instead of native tool_calls. */
export function stripLeakedToolCallMarkup(content: string): string {
    return content
        .replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, '')
        .replace(/<function_calls>[\s\S]*$/gi, '')
        .replace(/<function_response>[\s\S]*?<\/function_response>/gi, '')
        .replace(/<function_response>[\s\S]*$/gi, '')
        .replace(/<invoke\s+name="[^"]*">[\s\S]*?<\/invoke>/gi, '')
        .replace(/<invoke\s+name="[^"]*">[\s\S]*$/gi, '')
        .replace(/<\/invoke>/gi, '')
        .replace(/<\/?parameter[^>]*>/gi, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export function appendRateLimitWaitNotice(content: string, remainingMs?: number): string {
    const base = stripRateLimitWaitNotice(content);
    const notice = rateLimitWaitNotice(remainingMs);
    return base ? `${base}\n\n${notice}` : notice;
}

/** Pause ~1 minute, then let the caller retry the LLM call. */
export async function waitForRateLimitCooldown(
    signal?: AbortSignal,
    onTick?: (remainingMs: number) => void
): Promise<void> {
    const deadline = Date.now() + RATE_LIMIT_RETRY_WAIT_MS;
    onTick?.(RATE_LIMIT_RETRY_WAIT_MS);

    while (Date.now() < deadline) {
        if (signal?.aborted) {
            throw new Error('Aborted');
        }
        const remaining = deadline - Date.now();
        const step = Math.min(5000, remaining);
        await new Promise((r) => setTimeout(r, step));
        const left = deadline - Date.now();
        if (left > 0 && left <= 20_000) {
            onTick?.(left);
        }
    }
}

/** Plain-English chat error for operators (no "Unknown error" when we know it's rate limiting). */
export function formatChatErrorForUser(error: unknown): string {
    if (isRateLimitError(error)) {
        return (
            `### Could not complete your request\n\n` +
            `Grafana's AI service hit a **too many requests per minute** limit. ` +
            `Graft already waited about **one minute** and retried once; the limit was still in effect.\n\n` +
            `**What to do:** Wait **another minute**, then reply **Continue** (or send your request again once). ` +
            `Avoid pressing Enter repeatedly — each try counts against the limit.`
        );
    }

    const detail = extractErrorMessage(error);
    return (
        `### Could not complete your request\n\n` +
        `${detail}\n\n` +
        `**What to do:** Wait a minute and try again. If it keeps failing, check Grafana LLM settings or ask your admin.`
    );
}
