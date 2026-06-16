import { runSpecialist } from './specialist';
import type { PlanStep } from './types';

const mockChatCompletions = jest.fn();

jest.mock('@grafana/llm', () => ({
    llm: {
        chatCompletions: (...args: any[]) => mockChatCompletions(...args),
        Model: { BASE: 'base', LARGE: 'large' },
    },
}));

const makeStep = (overrides: Partial<PlanStep> = {}): PlanStep => ({
    id: 'step_1',
    description: 'Query CPU metrics',
    toolCategories: ['prometheus'],
    dependsOn: [],
    ...overrides,
});

const makeResponse = (content: string, toolCalls?: any[]) => ({
    choices: [{
        message: {
            content,
            tool_calls: toolCalls ?? [],
        },
    }],
});

const makeToolCall = (name: string, id = 'tc1', args = '{}') => ({
    id,
    function: { name, arguments: args },
});

describe('runSpecialist', () => {
    let mockMcpClient: { callTool: jest.Mock };
    let onUpdate: jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        mockMcpClient = { callTool: jest.fn() };
        onUpdate = jest.fn();
    });

    it('returns success result when no tool calls are needed', async () => {
        mockChatCompletions.mockResolvedValue(makeResponse('CPU usage is 42%'));

        const result = await runSpecialist(
            makeStep(),
            'what is CPU usage?',
            '',
            [],
            mockMcpClient,
            10,
            new AbortController().signal,
            onUpdate
        );

        expect(result.status).toBe('success');
        expect(result.summary).toContain('CPU usage is 42%');
        expect(result.stepId).toBe('step_1');
        expect(result.toolExecutions).toEqual([]);
    });

    it('only passes tools matching the step toolCategories', async () => {
        mockChatCompletions.mockResolvedValue(makeResponse('done'));

        const allTools = [
            { type: 'function', function: { name: 'query_prometheus' } },
            { type: 'function', function: { name: 'query_loki_logs' } },
            { type: 'function', function: { name: 'get_dashboard_by_uid' } },
        ];

        await runSpecialist(
            makeStep({ toolCategories: ['prometheus'] }),
            'query metrics',
            '',
            allTools,
            mockMcpClient,
            10,
            new AbortController().signal,
            onUpdate
        );

        const callArg = mockChatCompletions.mock.calls[0][0];
        const toolNames = callArg.tools?.map((t: any) => t.function.name) ?? [];
        expect(toolNames).toContain('query_prometheus');
        expect(toolNames).not.toContain('query_loki_logs');
        expect(toolNames).not.toContain('get_dashboard_by_uid');
    });

    it('executes tool calls and calls onUpdate per tool', async () => {
        const toolCall = makeToolCall('query_prometheus');
        mockChatCompletions
            .mockResolvedValueOnce(makeResponse('', [toolCall]))
            .mockResolvedValueOnce(makeResponse('Metrics fetched.'));
        mockMcpClient.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'result data' }] });

        const result = await runSpecialist(
            makeStep(),
            'show metrics',
            '',
            [{ type: 'function', function: { name: 'query_prometheus' } }],
            mockMcpClient,
            10,
            new AbortController().signal,
            onUpdate
        );

        expect(mockMcpClient.callTool).toHaveBeenCalledWith({ name: 'query_prometheus', arguments: {} });

        // First onUpdate call: after pushing pending status
        const firstCallArgs = onUpdate.mock.calls[0];
        expect(firstCallArgs[0]).toBe('step_1');
        expect(firstCallArgs[1]).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'query_prometheus', status: 'pending' }),
        ]));

        // Second onUpdate call: after tool succeeds
        const lastCallArgs = onUpdate.mock.calls[onUpdate.mock.calls.length - 1];
        expect(lastCallArgs[0]).toBe('step_1');
        expect(lastCallArgs[1]).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'query_prometheus', status: 'success' }),
        ]));
        expect(result.status).toBe('success');
    });

    it('compresses prior tool results before the next LLM call', async () => {
        const toolCall = makeToolCall('query_prometheus', 'tc1');
        mockChatCompletions
            .mockResolvedValueOnce(makeResponse('', [toolCall]))
            .mockResolvedValueOnce(makeResponse('Done.'));
        mockMcpClient.callTool.mockResolvedValue({
            content: [{ type: 'text', text: 'A'.repeat(500) }],
        });

        await runSpecialist(
            makeStep(),
            'query',
            '',
            [{ type: 'function', function: { name: 'query_prometheus' } }],
            mockMcpClient,
            10,
            new AbortController().signal,
            onUpdate
        );

        // Second chatCompletions call should have compressed tool message, not full 500-char result
        const secondCallMessages = mockChatCompletions.mock.calls[1][0].messages;
        const toolMsg = secondCallMessages.find((m: any) => m.role === 'tool' && m.tool_call_id === 'tc1');
        expect(toolMsg).toBeDefined();
        expect(toolMsg.content).toContain('[query_prometheus result processed');
        // The compressed form should be much shorter than the raw 500-char result
        expect(toolMsg.content.length).toBeLessThan(400);
    });

    it('returns error result when mcpClient.callTool throws', async () => {
        const toolCall = makeToolCall('query_prometheus');
        mockChatCompletions.mockResolvedValue(makeResponse('', [toolCall]));
        mockMcpClient.callTool.mockRejectedValue(new Error('datasource timeout'));

        const result = await runSpecialist(
            makeStep(),
            'query',
            '',
            [{ type: 'function', function: { name: 'query_prometheus' } }],
            mockMcpClient,
            10,
            new AbortController().signal,
            onUpdate
        );

        expect(result.status).toBe('success'); // specialist itself doesn't fail on tool error
        expect(onUpdate).toHaveBeenCalledWith('step_1', expect.arrayContaining([
            expect.objectContaining({ name: 'query_prometheus', status: 'error' }),
        ]));
    });

    it('throws when AbortSignal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();

        mockChatCompletions.mockResolvedValue(makeResponse('', [makeToolCall('query_prometheus')]));
        mockMcpClient.callTool.mockResolvedValue({ content: [] });

        await expect(
            runSpecialist(
                makeStep(),
                'query',
                '',
                [{ type: 'function', function: { name: 'query_prometheus' } }],
                mockMcpClient,
                10,
                controller.signal,
                onUpdate
            )
        ).rejects.toThrow('Aborted');
    });

    it('appends MAX_ITERATIONS notice when iterations are exhausted', async () => {
        // Always return tool calls to exhaust the loop
        const toolCall = makeToolCall('query_prometheus');
        mockChatCompletions.mockResolvedValue(makeResponse('partial', [toolCall]));
        mockMcpClient.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'data' }] });

        const result = await runSpecialist(
            makeStep(),
            'query',
            '',
            [{ type: 'function', function: { name: 'query_prometheus' } }],
            mockMcpClient,
            2, // maxIterations = 2
            new AbortController().signal,
            onUpdate
        );

        expect(result.summary).toContain('Maximum tool call steps (2)');
    });

    it('returns error SpecialistResult (not throw) on unexpected LLM error', async () => {
        mockChatCompletions.mockRejectedValue(new Error('LLM unreachable'));

        const result = await runSpecialist(
            makeStep(),
            'query',
            '',
            [],
            mockMcpClient,
            10,
            new AbortController().signal,
            onUpdate
        );

        expect(result.status).toBe('error');
        expect(result.error).toBe('LLM unreachable');
        expect(result.toolExecutions).toEqual([]);
    });

    describe('dataFindings — code-enforced validation (Fix 2A + 2B)', () => {
        const lokiJson = JSON.stringify({
            datasourceUid: 'loki-uid',
            datasourceName: 'Loki',
            labels: { job: ['api'] },
            validatedQueries: [{ description: 'errors', logql: '{job="api"} |= "error"' }],
        });

        it('accepts LokiFindings when query_loki_logs was successfully called', async () => {
            // First call returns a tool call (query_loki_logs), second returns findings JSON
            const toolCall = makeToolCall('query_loki_logs', 'tc1');
            mockChatCompletions
                .mockResolvedValueOnce(makeResponse('', [toolCall]))
                .mockResolvedValueOnce(makeResponse(lokiJson));
            mockMcpClient.callTool.mockResolvedValue({
                content: [{ type: 'text', text: '[{"streams":[]}]' }],
            });

            const result = await runSpecialist(
                makeStep({ toolCategories: ['loki'] }),
                'find loki services',
                '',
                [{ type: 'function', function: { name: 'query_loki_logs' } }],
                mockMcpClient,
                10,
                new AbortController().signal,
                onUpdate
            );

            expect(result.status).toBe('success');
            expect(result.dataFindings?.loki?.datasourceUid).toBe('loki-uid');
            expect(result.dataFindings?.loki?.validatedQueries).toHaveLength(1);
            expect(result.summary).toContain('Loki datasource');
        });

        it('rejects dataFindings when query_loki_logs was NOT called (Fix 2A: ground-truth check)', async () => {
            // Model returns JSON findings directly without making any tool calls
            mockChatCompletions.mockResolvedValue(makeResponse(lokiJson));

            const result = await runSpecialist(
                makeStep({ toolCategories: ['loki'] }),
                'find loki services',
                '',
                [],
                mockMcpClient,
                10,
                new AbortController().signal,
                onUpdate
            );

            // Findings must be rejected — the model claimed to validate but made no tool call
            expect(result.dataFindings).toBeUndefined();
        });

        it('rejects dataFindings when query_loki_logs call errored (Fix 2A: only success counts)', async () => {
            const toolCall = makeToolCall('query_loki_logs', 'tc1');
            mockChatCompletions
                .mockResolvedValueOnce(makeResponse('', [toolCall]))
                .mockResolvedValueOnce(makeResponse(lokiJson));
            // Tool call fails
            mockMcpClient.callTool.mockRejectedValue(new Error('datasource unreachable'));

            const result = await runSpecialist(
                makeStep({ toolCategories: ['loki'] }),
                'find loki services',
                '',
                [{ type: 'function', function: { name: 'query_loki_logs' } }],
                mockMcpClient,
                10,
                new AbortController().signal,
                onUpdate
            );

            // Tool call errored — findings should be rejected
            expect(result.dataFindings).toBeUndefined();
        });

        it('makes json_object follow-up call when model responds with prose (Fix 2B)', async () => {
            // First call: tool call, Second call: prose instead of JSON, Third: json_object follow-up
            const toolCall = makeToolCall('query_loki_logs', 'tc1');
            mockChatCompletions
                .mockResolvedValueOnce(makeResponse('', [toolCall]))
                .mockResolvedValueOnce(makeResponse('I found the Loki labels.'))  // prose, not JSON
                .mockResolvedValueOnce(makeResponse(lokiJson)); // json_object follow-up
            mockMcpClient.callTool.mockResolvedValue({ content: [{ type: 'text', text: '{}' }] });

            const result = await runSpecialist(
                makeStep({ toolCategories: ['loki'] }),
                'find labels',
                '',
                [{ type: 'function', function: { name: 'query_loki_logs' } }],
                mockMcpClient,
                10,
                new AbortController().signal,
                onUpdate
            );

            // Third call should have response_format: json_object
            expect(mockChatCompletions).toHaveBeenCalledTimes(3);
            const thirdCall = mockChatCompletions.mock.calls[2][0];
            expect(thirdCall.response_format).toEqual({ type: 'json_object' });
            // Findings should be parsed from the follow-up response
            expect(result.dataFindings?.loki?.datasourceUid).toBe('loki-uid');
        });

        it('returns undefined dataFindings for non-data steps', async () => {
            mockChatCompletions.mockResolvedValue(makeResponse('Step done.'));

            const result = await runSpecialist(
                makeStep({ toolCategories: ['datasources'] }),
                'list datasources',
                '',
                [],
                mockMcpClient,
                10,
                new AbortController().signal,
                onUpdate
            );

            expect(result.dataFindings).toBeUndefined();
        });

        it('returns undefined dataFindings when response is not valid JSON and follow-up also fails', async () => {
            const toolCall = makeToolCall('query_loki_logs', 'tc1');
            mockChatCompletions
                .mockResolvedValueOnce(makeResponse('', [toolCall]))
                .mockResolvedValueOnce(makeResponse('Could not find any Loki labels.'))
                .mockResolvedValueOnce(makeResponse('still not json'));
            mockMcpClient.callTool.mockResolvedValue({ content: [] });

            const result = await runSpecialist(
                makeStep({ toolCategories: ['loki'] }),
                'find labels',
                '',
                [{ type: 'function', function: { name: 'query_loki_logs' } }],
                mockMcpClient,
                10,
                new AbortController().signal,
                onUpdate
            );

            expect(result.status).toBe('success');
            expect(result.dataFindings).toBeUndefined();
        });

        it('injects query validation instruction into system prompt for loki steps', async () => {
            mockChatCompletions.mockResolvedValue(makeResponse('{}'));

            await runSpecialist(
                makeStep({ toolCategories: ['loki'] }),
                'query logs',
                '',
                [],
                mockMcpClient,
                10,
                new AbortController().signal,
                onUpdate
            );

            const systemMsg = mockChatCompletions.mock.calls[0][0].messages
                .find((m: any) => m.role === 'system')?.content ?? '';
            expect(systemMsg).toContain('query_loki_logs');
            expect(systemMsg).toContain('Query validation rule');
        });

        it('does NOT inject query validation for non-data steps', async () => {
            mockChatCompletions.mockResolvedValue(makeResponse('done'));

            await runSpecialist(
                makeStep({ toolCategories: ['datasources'] }),
                'list datasources',
                '',
                [],
                mockMcpClient,
                10,
                new AbortController().signal,
                onUpdate
            );

            const systemMsg = mockChatCompletions.mock.calls[0][0].messages
                .find((m: any) => m.role === 'system')?.content ?? '';
            expect(systemMsg).not.toContain('Query validation rule');
        });
    });
});
