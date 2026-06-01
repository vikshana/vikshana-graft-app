import type { Message } from '../types/llm.types';

/**
 * Groups messages into exchanges for truncation purposes.
 * An exchange is a user message followed by an assistant response,
 * including any tool call sequences (assistant+tool messages) within it.
 *
 * System messages are returned separately and always preserved.
 */
function splitIntoExchanges(messages: Message[]): { system: Message[]; exchanges: Message[][] } {
    const system: Message[] = [];
    const rest: Message[] = [];

    for (const msg of messages) {
        if (msg.role === 'system') {
            system.push(msg);
        } else {
            rest.push(msg);
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

    return { system, exchanges };
}

/**
 * Truncates a message list to at most `maxExchanges` user/assistant exchanges,
 * always preserving system messages and keeping tool call sequences intact.
 */
export function truncateMessages(messages: Message[], maxExchanges: number): Message[] {
    const { system, exchanges } = splitIntoExchanges(messages);

    const retained = exchanges.length > maxExchanges
        ? exchanges.slice(exchanges.length - maxExchanges)
        : exchanges;

    return [...system, ...retained.flat()];
}
