import { truncateMessages } from './truncation';
import type { Message } from '../types/llm.types';

const user = (content: string): Message => ({ role: 'user', content });
const assistant = (content: string, tool_calls?: any[]): Message => ({ role: 'assistant', content, tool_calls });
const tool = (content: string, tool_call_id: string): Message => ({ role: 'tool', content, tool_call_id });
const system = (content: string): Message => ({ role: 'system', content });

describe('truncateMessages', () => {
    it('returns messages unchanged when within limit', () => {
        const messages = [user('hi'), assistant('hello')];
        expect(truncateMessages(messages, 10)).toEqual(messages);
    });

    it('drops oldest exchanges when over limit', () => {
        const messages = [
            user('msg1'), assistant('resp1'),
            user('msg2'), assistant('resp2'),
            user('msg3'), assistant('resp3'),
        ];
        const result = truncateMessages(messages, 2);
        expect(result).toEqual([
            user('msg2'), assistant('resp2'),
            user('msg3'), assistant('resp3'),
        ]);
    });

    it('always preserves system messages', () => {
        const messages = [
            system('You are a helpful assistant.'),
            user('msg1'), assistant('resp1'),
            user('msg2'), assistant('resp2'),
            user('msg3'), assistant('resp3'),
        ];
        const result = truncateMessages(messages, 1);
        expect(result).toEqual([
            system('You are a helpful assistant.'),
            user('msg3'), assistant('resp3'),
        ]);
    });

    it('keeps tool call sequences intact as part of an exchange', () => {
        const toolCall = { id: 'tc1', function: { name: 'query', arguments: '{}' } };
        const messages = [
            user('msg1'), assistant('resp1'),
            user('msg2'),
            assistant('calling tool', [toolCall]),
            tool('tool result', 'tc1'),
            assistant('final answer'),
        ];
        const result = truncateMessages(messages, 1);
        // Exchange 1: [user msg1, assistant resp1] — dropped
        // Exchange 2: [user msg2, assistant+tool_calls, tool, assistant] — kept
        expect(result).toEqual([
            user('msg2'),
            assistant('calling tool', [toolCall]),
            tool('tool result', 'tc1'),
            assistant('final answer'),
        ]);
    });

    it('handles empty message list', () => {
        expect(truncateMessages([], 5)).toEqual([]);
    });

    it('handles messages with only system message', () => {
        const messages = [system('sys')];
        expect(truncateMessages(messages, 5)).toEqual([system('sys')]);
    });

    it('handles a single exchange at limit boundary', () => {
        const messages = [user('q'), assistant('a')];
        expect(truncateMessages(messages, 1)).toEqual([user('q'), assistant('a')]);
    });

    it('preserves multiple system messages', () => {
        const messages = [
            system('sys1'),
            system('sys2'),
            user('msg1'), assistant('resp1'),
            user('msg2'), assistant('resp2'),
        ];
        const result = truncateMessages(messages, 1);
        expect(result).toEqual([
            system('sys1'),
            system('sys2'),
            user('msg2'), assistant('resp2'),
        ]);
    });

    // -------------------------------------------------------------------------
    // Trailing user message (the common in-flight case: last message is a user
    // turn with no assistant reply yet, e.g. the message array just before
    // sending to the LLM).
    // -------------------------------------------------------------------------

    it('treats a trailing user message as its own exchange', () => {
        const messages = [
            user('msg1'), assistant('resp1'),
            user('msg2'), assistant('resp2'),
            user('msg3'), // in-flight — no assistant reply yet
        ];
        const result = truncateMessages(messages, 2);
        // Exchange 1: [user msg1, assistant resp1] — dropped
        // Exchange 2: [user msg2, assistant resp2] — kept
        // Exchange 3: [user msg3] — kept (counts as an exchange)
        expect(result).toEqual([
            user('msg2'), assistant('resp2'),
            user('msg3'),
        ]);
    });

    it('keeps a sole trailing user message when maxExchanges >= 1', () => {
        const messages = [user('hello')];
        expect(truncateMessages(messages, 1)).toEqual([user('hello')]);
    });

    it('drops a trailing user message when maxExchanges = 0', () => {
        const messages = [
            system('sys'),
            user('msg1'), assistant('resp1'),
            user('msg2'),
        ];
        expect(truncateMessages(messages, 0)).toEqual([system('sys')]);
    });

    // -------------------------------------------------------------------------
    // maxExchanges edge cases
    // -------------------------------------------------------------------------

    it('returns only system messages when maxExchanges is 0', () => {
        const messages = [
            system('sys'),
            user('msg1'), assistant('resp1'),
        ];
        expect(truncateMessages(messages, 0)).toEqual([system('sys')]);
    });

    it('treats negative maxExchanges as 0', () => {
        const messages = [
            system('sys'),
            user('msg1'), assistant('resp1'),
        ];
        expect(truncateMessages(messages, -5)).toEqual([system('sys')]);
    });

    it('returns empty array for negative maxExchanges with no system messages', () => {
        const messages = [user('msg1'), assistant('resp1')];
        expect(truncateMessages(messages, -1)).toEqual([]);
    });

    // -------------------------------------------------------------------------
    // System message ordering
    // -------------------------------------------------------------------------

    it('preserves a mid-conversation system message at its original position', () => {
        const sys = system('policy update');
        const messages = [
            user('msg1'), assistant('resp1'),
            sys,
            user('msg2'), assistant('resp2'),
            user('msg3'), assistant('resp3'),
        ];
        const result = truncateMessages(messages, 2);
        // Exchange 1 (msg1/resp1) dropped; sys sits between exchange 1 and 2,
        // so it falls before the retained window — still prepended.
        // Exchanges 2 and 3 are retained.
        expect(result).toEqual([
            sys,
            user('msg2'), assistant('resp2'),
            user('msg3'), assistant('resp3'),
        ]);
    });

    it('keeps a system message that falls inside the retained window in place', () => {
        const sys = system('mid-window policy');
        const messages = [
            user('msg1'), assistant('resp1'),
            user('msg2'),
            sys,
            assistant('resp2'),
            user('msg3'), assistant('resp3'),
        ];
        const result = truncateMessages(messages, 2);
        // Exchange 1 dropped; exchanges 2 (msg2, sys, resp2) and 3 retained.
        expect(result).toEqual([
            user('msg2'),
            sys,
            assistant('resp2'),
            user('msg3'), assistant('resp3'),
        ]);
    });
});
