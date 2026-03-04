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
});
