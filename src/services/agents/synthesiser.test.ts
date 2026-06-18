import { runSynthesiser } from './synthesiser';
import type { SpecialistResult } from './types';

const mockChatCompletions = jest.fn();

jest.mock('@grafana/llm', () => ({
    llm: {
        chatCompletions: (...args: any[]) => mockChatCompletions(...args),
        Model: { BASE: 'base', LARGE: 'large' },
    },
}));

const ok = (stepId: string, summary: string): SpecialistResult => ({
    stepId, status: 'success', summary, toolExecutions: [],
});
const fail = (stepId: string, summary: string, error: string): SpecialistResult => ({
    stepId, status: 'error', summary, error, toolExecutions: [],
});

describe('runSynthesiser', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockChatCompletions.mockResolvedValue({
            choices: [{ message: { content: 'Synthesised response.' } }],
        });
    });

    it('returns the model response content', async () => {
        const output = await runSynthesiser('show errors', [ok('step_1', 'Found 42 error lines.')], 'standard');
        expect(output).toBe('Synthesised response.');
    });

    it('uses Model.BASE for standard modelType', async () => {
        await runSynthesiser('query', [], 'standard');
        expect(mockChatCompletions).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'base' })
        );
    });

    it('uses Model.LARGE for thinking modelType', async () => {
        await runSynthesiser('query', [], 'thinking');
        expect(mockChatCompletions).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'large' })
        );
    });

    it('includes all successful step summaries in the prompt', async () => {
        const results = [
            ok('step_1', 'Prometheus: found 3 series.'),
            ok('step_2', 'Loki: found 10 error lines.'),
        ];
        await runSynthesiser('build dashboard', results, 'standard');

        const call = mockChatCompletions.mock.calls[0][0];
        const userMsg = call.messages.find((m: any) => m.role === 'user')?.content ?? '';
        expect(userMsg).toContain('Prometheus: found 3 series.');
        expect(userMsg).toContain('Loki: found 10 error lines.');
    });

    it('includes failed step error details in the prompt', async () => {
        const results = [
            ok('step_1', 'Done.'),
            fail('step_2', 'Step failed.', 'datasource timeout'),
        ];
        await runSynthesiser('build dashboard', results, 'standard');

        const call = mockChatCompletions.mock.calls[0][0];
        const userMsg = call.messages.find((m: any) => m.role === 'user')?.content ?? '';
        expect(userMsg).toContain('datasource timeout');
        expect(userMsg).toContain('step_2 (failed)');
    });

    it('handles all steps failed gracefully', async () => {
        const results = [fail('step_1', 'Failed.', 'network error')];
        const output = await runSynthesiser('query', results, 'standard');
        expect(output).toBe('Synthesised response.');
        const call = mockChatCompletions.mock.calls[0][0];
        const userMsg = call.messages.find((m: any) => m.role === 'user')?.content ?? '';
        expect(userMsg).toContain('network error');
    });

    it('handles empty results array', async () => {
        const output = await runSynthesiser('what time is it?', [], 'standard');
        expect(output).toBe('Synthesised response.');
    });

    it('returns empty string when model returns empty content (not a fallback case)', async () => {
        mockChatCompletions.mockResolvedValue({ choices: [{ message: { content: '' } }] });
        const output = await runSynthesiser('query', [], 'standard');
        expect(output).toBe('');
    });

    it('returns fallback string when choices array is empty', async () => {
        mockChatCompletions.mockResolvedValue({ choices: [] });
        const output = await runSynthesiser('query', [], 'standard');
        expect(output).toBe('No response generated.');
    });

    it('does not pass any tools to the LLM call', async () => {
        await runSynthesiser('query', [], 'standard');
        const call = mockChatCompletions.mock.calls[0][0];
        expect(call.tools).toBeUndefined();
    });
});
