import {
    appendRateLimitWaitNotice,
    formatChatErrorForUser,
    isRateLimitError,
    rateLimitWaitNotice,
    RATE_LIMIT_RETRY_WAIT_MS,
    stripLeakedToolCallMarkup,
    waitForRateLimitCooldown,
} from './chatError';

describe('chatError', () => {
    it('detects rate limit messages', () => {
        expect(isRateLimitError(new Error('too many requests'))).toBe(true);
        expect(isRateLimitError({ status: 429, message: 'Rate limit' })).toBe(true);
        expect(isRateLimitError(new Error('too many requests per minute'))).toBe(true);
    });

    it('formats rate limit for operators', () => {
        const text = formatChatErrorForUser(new Error('too many requests'));
        expect(text).toContain('per minute');
        expect(text).toContain('Continue');
        expect(text).not.toContain('Unknown error');
    });

    it('builds in-chat wait notice with countdown seconds', () => {
        expect(rateLimitWaitNotice(60_000)).toContain('60 second');
        expect(rateLimitWaitNotice(15_000)).toContain('15 second');
        expect(appendRateLimitWaitNotice('Working…', 45_000)).toContain('Working…');
        expect(appendRateLimitWaitNotice('Working…', 45_000)).toContain('45 second');
    });

    it('waits about one minute before retry', async () => {
        jest.useFakeTimers();
        const ticks: number[] = [];
        const p = waitForRateLimitCooldown(undefined, (ms) => ticks.push(ms));
        await jest.advanceTimersByTimeAsync(RATE_LIMIT_RETRY_WAIT_MS);
        await p;
        expect(ticks[0]).toBe(RATE_LIMIT_RETRY_WAIT_MS);
        jest.useRealTimers();
    });

    it('strips leaked function_response markup', () => {
        const raw =
            'Here you go\n<function_response>[{"uid":"abc"}]</invoke></function_response>\nDone';
        expect(stripLeakedToolCallMarkup(raw)).toBe('Here you go\nDone');
    });
});