import type { Message } from '../types/llm.types';

/**
 * Groups non-system messages into exchanges for truncation purposes.
 * An exchange is a user message followed by an assistant response,
 * including any tool call sequences (assistant+tool messages) within it.
 *
 * Returns the exchanges together with the original indices of every system
 * message, so callers can reinstate them at their original positions after
 * truncation without reordering the conversation.
 */
function splitIntoExchanges(messages: Message[]): {
    systemEntries: Array<{ index: number; message: Message }>;
    exchanges: Message[][];
} {
    const systemEntries: Array<{ index: number; message: Message }> = [];
    const rest: Message[] = [];

    for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === 'system') {
            systemEntries.push({ index: i, message: messages[i] });
        } else {
            rest.push(messages[i]);
        }
    }

    const exchanges: Message[][] = [];
    let current: Message[] = [];

    for (const msg of rest) {
        if (msg.role === 'user' && current.length > 0) {
            // Starting a new user turn — flush the current exchange
            exchanges.push(current);
            current = [];
        }
        current.push(msg);
    }

    if (current.length > 0) {
        exchanges.push(current);
    }

    return { systemEntries, exchanges };
}

/**
 * Truncates a message list to at most `maxExchanges` user/assistant exchanges,
 * preserving system messages at their original positions and keeping tool call
 * sequences intact.
 *
 * Passing 0 retains only system messages. Negative values are clamped to 0.
 */
export function truncateMessages(messages: Message[], maxExchanges: number): Message[] {
    const clampedMax = Math.max(0, maxExchanges);
    const { systemEntries, exchanges } = splitIntoExchanges(messages);

    const retained = exchanges.length > clampedMax
        ? exchanges.slice(exchanges.length - clampedMax)
        : exchanges;

    // Flat list of non-system messages after truncation, with their
    // original (pre-truncation) positions stripped out — we need to
    // reconstruct original ordering relative to the dropped prefix.
    //
    // Strategy: find the index in the original message array where the
    // first retained exchange starts, then walk forward from there,
    // re-inserting system messages whose original index falls before each
    // non-system message.
    const retainedFlat = retained.flat();

    if (retainedFlat.length === 0) {
        // Only system messages remain (or nothing at all)
        return systemEntries.map(e => e.message);
    }

    // Find where in the original array the retained block begins.
    // We match by object identity since the same Message references are used.
    const firstRetained = retainedFlat[0];
    const startIndex = messages.indexOf(firstRetained);

    // Build output: interleave system messages that originally appeared
    // at or after startIndex, in their original relative order.
    const output: Message[] = [];

    // System messages before the retained window are still prepended —
    // they carry prompt-level instructions that must survive truncation.
    // System messages within or after the retained window are re-inserted
    // at their original positions.
    const beforeWindow = systemEntries.filter(e => e.index < startIndex);
    const withinWindow = systemEntries.filter(e => e.index >= startIndex);

    for (const e of beforeWindow) {
        output.push(e.message);
    }

    let sysPtr = 0;
    for (const msg of retainedFlat) {
        const originalIndex = messages.indexOf(msg);
        // Insert any system messages whose original index comes before this message
        while (sysPtr < withinWindow.length && withinWindow[sysPtr].index < originalIndex) {
            output.push(withinWindow[sysPtr].message);
            sysPtr++;
        }
        output.push(msg);
    }
    // Flush any trailing system messages
    while (sysPtr < withinWindow.length) {
        output.push(withinWindow[sysPtr].message);
        sysPtr++;
    }

    return output;
}
