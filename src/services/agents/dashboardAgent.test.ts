import { runDashboardAgent } from './dashboardAgent';
import type { PlanStep, DataFindings } from './types';

const mockChatCompletions = jest.fn();

jest.mock('@grafana/llm', () => ({
    llm: {
        chatCompletions: (...args: any[]) => mockChatCompletions(...args),
        Model: { BASE: 'base', LARGE: 'large' },
    },
}));

const makeStep = (overrides: Partial<PlanStep> = {}): PlanStep => ({
    id: 'step_3',
    description: 'Build a service log monitoring dashboard',
    toolCategories: ['dashboards'],
    dependsOn: ['step_1'],
    ...overrides,
});

const lokiFindings: DataFindings = {
    loki: {
        datasourceUid: 'loki-uid-123',
        datasourceName: 'Loki',
        labels: { job: ['api-server', 'frontend'], level: ['error', 'info'] },
        validatedQueries: [
            { description: 'Error log volume by service', logql: '{job=~".+"} |= "error" | logfmt' },
            { description: 'All logs', logql: '{job=~".+"}' },
        ],
    },
};

const makeResponse = (content: string, toolCalls?: any[]) => ({
    choices: [{ message: { content, tool_calls: toolCalls ?? [] } }],
});

const makeToolCall = (name: string, id = 'tc1', args = '{}') => ({
    id,
    function: { name, arguments: args },
});

describe('runDashboardAgent', () => {
    let mockMcpClient: { callTool: jest.Mock };
    let onUpdate: jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        mockMcpClient = { callTool: jest.fn() };
        onUpdate = jest.fn();
    });

    it('uses Model.LARGE — never Model.BASE', async () => {
        mockChatCompletions.mockResolvedValue(makeResponse('Dashboard created.'));

        await runDashboardAgent(
            makeStep(), 'build dashboard', '', lokiFindings,
            [], mockMcpClient, 10, new AbortController().signal, onUpdate
        );

        for (const call of mockChatCompletions.mock.calls) {
            expect(call[0].model).toBe('large');
        }
    });

    it('only passes dashboard and datasource tools — not loki or prometheus', async () => {
        mockChatCompletions.mockResolvedValue(makeResponse('done'));

        const allTools = [
            { type: 'function', function: { name: 'query_loki_logs' } },
            { type: 'function', function: { name: 'query_prometheus' } },
            { type: 'function', function: { name: 'get_dashboard_by_uid' } },
            { type: 'function', function: { name: 'update_dashboard' } },
            { type: 'function', function: { name: 'list_datasources' } },
        ];

        await runDashboardAgent(
            makeStep(), 'build dashboard', '', lokiFindings,
            allTools, mockMcpClient, 10, new AbortController().signal, onUpdate
        );

        const callArg = mockChatCompletions.mock.calls[0][0];
        const toolNames = callArg.tools?.map((t: any) => t.function.name) ?? [];
        expect(toolNames).toContain('get_dashboard_by_uid');
        expect(toolNames).toContain('update_dashboard');
        expect(toolNames).toContain('list_datasources');
        expect(toolNames).not.toContain('query_loki_logs');
        expect(toolNames).not.toContain('query_prometheus');
    });

    it('includes validated Loki queries in the system prompt', async () => {
        mockChatCompletions.mockResolvedValue(makeResponse('done'));

        await runDashboardAgent(
            makeStep(), 'build dashboard', '', lokiFindings,
            [], mockMcpClient, 10, new AbortController().signal, onUpdate
        );

        const systemMsg = mockChatCompletions.mock.calls[0][0].messages
            .find((m: any) => m.role === 'system')?.content ?? '';
        expect(systemMsg).toContain('loki-uid-123');
        expect(systemMsg).toContain('{job=~".+"} |= "error" | logfmt');
        expect(systemMsg).toContain('Error log volume by service');
    });

    it('returns success result with summary', async () => {
        mockChatCompletions.mockResolvedValue(
            makeResponse('Dashboard created: [Open](/d/abc123). 2 panels added.')
        );

        const result = await runDashboardAgent(
            makeStep(), 'build dashboard', '', lokiFindings,
            [], mockMcpClient, 10, new AbortController().signal, onUpdate
        );

        expect(result.status).toBe('success');
        expect(result.summary).toContain('[Open](/d/abc123)');
        expect(result.stepId).toBe('step_3');
        expect(result.toolExecutions).toEqual([]);
    });

    it('executes tool calls and calls onUpdate', async () => {
        const toolCall = makeToolCall('update_dashboard', 'tc1');
        mockChatCompletions
            .mockResolvedValueOnce(makeResponse('', [toolCall]))
            .mockResolvedValueOnce(makeResponse('Dashboard saved.'));
        mockMcpClient.callTool.mockResolvedValue({
            content: [{ type: 'text', text: '{"uid":"newdash123"}' }],
        });

        await runDashboardAgent(
            makeStep(), 'build', '', lokiFindings,
            [{ type: 'function', function: { name: 'update_dashboard' } }],
            mockMcpClient, 10, new AbortController().signal, onUpdate
        );

        expect(mockMcpClient.callTool).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'update_dashboard' })
        );
        expect(onUpdate).toHaveBeenCalledWith('step_3', expect.arrayContaining([
            expect.objectContaining({ name: 'update_dashboard', status: 'pending' }),
        ]));
    });

    it('does NOT compress get_dashboard_by_uid or update_dashboard results', async () => {
        const tc1 = makeToolCall('get_dashboard_by_uid', 'tc1');
        const tc2 = makeToolCall('update_dashboard', 'tc2');
        const dashJson = JSON.stringify({ uid: 'abc', panels: [] });

        mockChatCompletions
            .mockResolvedValueOnce(makeResponse('', [tc1]))
            .mockResolvedValueOnce(makeResponse('', [tc2]))
            .mockResolvedValueOnce(makeResponse('Done.'));

        mockMcpClient.callTool
            .mockResolvedValueOnce({ content: [{ type: 'text', text: dashJson }] })
            .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"status":"ok"}' }] });

        await runDashboardAgent(
            makeStep(), 'build', '', lokiFindings,
            [
                { type: 'function', function: { name: 'get_dashboard_by_uid' } },
                { type: 'function', function: { name: 'update_dashboard' } },
            ],
            mockMcpClient, 10, new AbortController().signal, onUpdate
        );

        // The second LLM call should still see the full get_dashboard_by_uid result (not compressed)
        const secondCallMessages = mockChatCompletions.mock.calls[1][0].messages;
        const dashMsg = secondCallMessages.find((m: any) => m.tool_call_id === 'tc1');
        expect(dashMsg).toBeDefined();
        // Content is JSON.stringify(result.content) which wraps the dashboard JSON in a content-block array.
        // The dashboard JSON is present as a string value inside — check for 'panels' (unescaped in the outer string)
        expect(dashMsg.content).toContain('panels');  // not compressed
    });

    it('appends MAX_ITERATIONS notice when loop is exhausted', async () => {
        const toolCall = makeToolCall('update_dashboard');
        mockChatCompletions.mockResolvedValue(makeResponse('partial', [toolCall]));
        mockMcpClient.callTool.mockResolvedValue({ content: [{ type: 'text', text: '{}' }] });

        const result = await runDashboardAgent(
            makeStep(), 'build', '', lokiFindings,
            [{ type: 'function', function: { name: 'update_dashboard' } }],
            mockMcpClient, 2, new AbortController().signal, onUpdate
        );

        expect(result.summary).toContain('Maximum tool call steps (2)');
    });

    it('returns error result on LLM failure without throwing', async () => {
        mockChatCompletions.mockRejectedValue(new Error('LARGE model unavailable'));

        const result = await runDashboardAgent(
            makeStep(), 'build', '', lokiFindings,
            [], mockMcpClient, 10, new AbortController().signal, onUpdate
        );

        expect(result.status).toBe('error');
        expect(result.error).toBe('LARGE model unavailable');
        expect(result.toolExecutions).toEqual([]);
    });

    it('throws on AbortSignal', async () => {
        const controller = new AbortController();
        controller.abort();

        mockChatCompletions.mockResolvedValue(makeResponse('', [makeToolCall('update_dashboard')]));
        mockMcpClient.callTool.mockResolvedValue({ content: [] });

        await expect(
            runDashboardAgent(
                makeStep(), 'build', '', lokiFindings,
                [{ type: 'function', function: { name: 'update_dashboard' } }],
                mockMcpClient, 10, controller.signal, onUpdate
            )
        ).rejects.toThrow('Aborted');
    });

    it('works with empty DataFindings (no upstream data)', async () => {
        mockChatCompletions.mockResolvedValue(makeResponse('Built from existing dashboards.'));

        const result = await runDashboardAgent(
            makeStep(), 'organise dashboards', '', {},
            [], mockMcpClient, 10, new AbortController().signal, onUpdate
        );

        expect(result.status).toBe('success');
        // System prompt should note no findings rather than crashing
        const systemMsg = mockChatCompletions.mock.calls[0][0].messages
            .find((m: any) => m.role === 'system')?.content ?? '';
        expect(systemMsg).toContain('No upstream data findings provided');
    });
});
