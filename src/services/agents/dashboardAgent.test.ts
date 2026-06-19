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
        expect(systemMsg).toContain('No pre-validated queries were provided');
    });

    it('instructs type-based datasource selection when findings are empty', async () => {
        mockChatCompletions.mockResolvedValue(makeResponse('done'));

        await runDashboardAgent(
            makeStep(), 'build a logs dashboard', '', {},
            [], mockMcpClient, 10, new AbortController().signal, onUpdate
        );

        const systemMsg = mockChatCompletions.mock.calls[0][0].messages
            .find((m: any) => m.role === 'system')?.content ?? '';
        // Must steer the agent to discover datasources and select by type
        expect(systemMsg).toContain('list_datasources');
        expect(systemMsg).toMatch(/type\s+"loki"/);
        expect(systemMsg).toMatch(/type\s+"prometheus"/);
        // Must explicitly forbid the LogQL-on-Prometheus mistake from the bug report
        expect(systemMsg).toContain('NEVER attach a LogQL query to a prometheus datasource');
    });

    it('requires mandatory self-correction of datasource mismatches before finishing', async () => {
        mockChatCompletions.mockResolvedValue(makeResponse('done'));

        await runDashboardAgent(
            makeStep(), 'build dashboard', '', lokiFindings,
            [], mockMcpClient, 10, new AbortController().signal, onUpdate
        );

        const systemMsg = mockChatCompletions.mock.calls[0][0].messages
            .find((m: any) => m.role === 'system')?.content ?? '';
        expect(systemMsg).toContain('get_dashboard_panel_queries');
        expect(systemMsg).toContain('datasource-type mismatch');
        expect(systemMsg).toMatch(/fix any datasource-type mismatch before finishing/i);
    });

    // ─── Directional hint tests (Fix B1) ─────────────────────────────────────

    it('emits Prometheus directive when preferredCategories is [prometheus] and findings are empty', async () => {
        mockChatCompletions.mockResolvedValue(makeResponse('done'));

        await runDashboardAgent(
            makeStep(), 'build a service monitoring dashboard', '', {},
            [], mockMcpClient, 10, new AbortController().signal, onUpdate,
            ['prometheus'], // preferredCategories
        );

        const systemMsg = mockChatCompletions.mock.calls[0][0].messages
            .find((m: any) => m.role === 'system')?.content ?? '';
        expect(systemMsg).toContain('Prometheus metrics');
        expect(systemMsg).toContain('PromQL');
        expect(systemMsg).toContain('"prometheus"');
        expect(systemMsg).toMatch(/Do NOT build a logs dashboard/i);
    });

    it('emits Loki directive when preferredCategories is [loki] and findings are empty', async () => {
        mockChatCompletions.mockResolvedValue(makeResponse('done'));

        await runDashboardAgent(
            makeStep(), 'build a log monitoring dashboard', '', {},
            [], mockMcpClient, 10, new AbortController().signal, onUpdate,
            ['loki'], // preferredCategories
        );

        const systemMsg = mockChatCompletions.mock.calls[0][0].messages
            .find((m: any) => m.role === 'system')?.content ?? '';
        expect(systemMsg).toContain('Loki logs');
        expect(systemMsg).toContain('LogQL');
        expect(systemMsg).toContain('"loki"');
        expect(systemMsg).toMatch(/Do NOT build a metrics dashboard/i);
    });

    it('emits neutral guidance when preferredCategories is ambiguous (both/empty)', async () => {
        mockChatCompletions.mockResolvedValue(makeResponse('done'));

        await runDashboardAgent(
            makeStep(), 'build a dashboard', '', {},
            [], mockMcpClient, 10, new AbortController().signal, onUpdate,
            ['loki', 'prometheus'], // ambiguous
        );

        const systemMsg = mockChatCompletions.mock.calls[0][0].messages
            .find((m: any) => m.role === 'system')?.content ?? '';
        // Neutral: neither a hard Prometheus nor a hard Loki directive
        expect(systemMsg).not.toMatch(/Do NOT build a logs dashboard/i);
        expect(systemMsg).not.toMatch(/Do NOT build a metrics dashboard/i);
        // But still instructs type-based selection
        expect(systemMsg).toMatch(/type.*loki/i);
        expect(systemMsg).toMatch(/type.*prometheus/i);
    });

    it('directional hint does NOT override pre-validated findings (prometheus hint + loki findings)', async () => {
        mockChatCompletions.mockResolvedValue(makeResponse('done'));

        await runDashboardAgent(
            makeStep(), 'build dashboard', '', lokiFindings,
            [], mockMcpClient, 10, new AbortController().signal, onUpdate,
            ['prometheus'], // hint says prometheus, but findings are loki
        );

        const systemMsg = mockChatCompletions.mock.calls[0][0].messages
            .find((m: any) => m.role === 'system')?.content ?? '';
        // Should show the pre-validated Loki findings, not the empty-findings directive
        expect(systemMsg).toContain('loki-uid-123');
        expect(systemMsg).toContain('Pre-validated data from upstream agents');
        expect(systemMsg).not.toContain('No pre-validated queries were provided');
    });

    it('includes datasource uid in prompt when findings have known uid but empty queries', async () => {
        mockChatCompletions.mockResolvedValue(makeResponse('done'));

        // Datasource-only findings: uid known but no validated queries (Fix A1)
        const datasourceOnlyFindings = {
            prometheus: {
                datasourceUid: 'prom-uid-456',
                datasourceName: 'Prometheus',
                labels: {},
                validatedQueries: [],
            },
        };

        await runDashboardAgent(
            makeStep(), 'build metrics dashboard', '', datasourceOnlyFindings,
            [], mockMcpClient, 10, new AbortController().signal, onUpdate,
            ['prometheus'],
        );

        const systemMsg = mockChatCompletions.mock.calls[0][0].messages
            .find((m: any) => m.role === 'system')?.content ?? '';
        // Should show partial findings with the UID (not the generic no-findings path)
        expect(systemMsg).toContain('prom-uid-456');
        expect(systemMsg).toContain('Datasource identified — no pre-validated queries');
    });

    it('embeds conversation digest in the system prompt when provided', async () => {
        mockChatCompletions.mockResolvedValue(makeResponse('done'));

        const digest = 'User: Which services generate metrics?\nAssistant: graft-plugin-frontend via Prometheus.';

        await runDashboardAgent(
            makeStep(), 'build a dashboard to monitor it', '', {},
            [], mockMcpClient, 10, new AbortController().signal, onUpdate,
            ['prometheus'],
            digest,
        );

        const systemMsg = mockChatCompletions.mock.calls[0][0].messages
            .find((m: any) => m.role === 'system')?.content ?? '';
        expect(systemMsg).toContain('graft-plugin-frontend via Prometheus');
        expect(systemMsg).toContain('Recent conversation');
    });
});

// ─── Enrichment integration ───────────────────────────────────────────────────

describe('runDashboardAgent — enrichment integration', () => {
    let mockMcpClient2: { callTool: jest.Mock };
    let onUpdate2: jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        mockMcpClient2 = { callTool: jest.fn() };
        onUpdate2 = jest.fn();
    });

    it('applies deterministic enrichment — prompt contains inferred unit for rate(_total) query', async () => {
        mockChatCompletions.mockResolvedValue(makeResponse('done'));

        // Provide a query without unit/suggestedViz — enrichment should fill them
        const rawFindings: DataFindings = {
            prometheus: {
                datasourceUid: 'prom-uid',
                datasourceName: 'Prometheus',
                labels: { job: ['api'] },
                validatedQueries: [
                    { description: 'Request rate', promql: 'rate(http_requests_total[5m])' },
                ],
            },
        };

        await runDashboardAgent(
            makeStep({ description: 'Build RED metrics dashboard' }),
            'build it', '', rawFindings,
            [], mockMcpClient2, 10, new AbortController().signal, onUpdate2,
        );

        const systemMsg = mockChatCompletions.mock.calls[0][0].messages
            .find((m: any) => m.role === 'system')?.content ?? '';

        // Enrichment should have derived unit: reqps for rate(_total) — appears in findings block
        expect(systemMsg).toContain('reqps');
        // Layout hint: RED detected from step description — row strategy changes
        expect(systemMsg).toContain('Request Rate');  // row title from RED layout hint
    });

    it('does NOT compress update_dashboard results (must be in NO_COMPRESS)', async () => {
        // update_dashboard result must be preserved verbatim — the agent needs to see
        // the full response (including UID) to proceed correctly.
        const uid = 'new-dash-uid-abc';
        const updateResult = JSON.stringify([{ text: JSON.stringify({ uid, status: 'success', version: 1 }) }]);

        mockChatCompletions
            .mockResolvedValueOnce(makeResponse('', [makeToolCall('update_dashboard', 'tc1', JSON.stringify({ dashboard: { title: 'Test', panels: [] }, overwrite: false }))]))
            .mockResolvedValueOnce(makeResponse('Dashboard created. [Open dashboard](/d/' + uid + ')'));

        const mcpClient = {
            callTool: jest.fn().mockResolvedValue({ content: updateResult }),
        };

        await runDashboardAgent(
            makeStep(), 'build', '', {},
            [], mcpClient, 10, new AbortController().signal, onUpdate2,
        );

        // The second LLM call's messages should contain the raw update_dashboard result,
        // NOT a compressed placeholder.
        const secondCallMessages = mockChatCompletions.mock.calls[1][0].messages;
        const toolRoleMsg = secondCallMessages.find((m: any) => m.role === 'tool' && m.tool_call_id === 'tc1');
        expect(toolRoleMsg).toBeDefined();
        expect(toolRoleMsg.content).not.toContain('[update_dashboard result processed');
        expect(toolRoleMsg.content).toContain(uid);
    });
});

// ─── V2 capability probe and fallback ────────────────────────────────────────

describe('runDashboardAgent — V2 capability probe', () => {
    let onUpdate3: jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        onUpdate3 = jest.fn();
    });

    it('uses v1 rules when schemaCapabilityHint is v1 (default)', async () => {
        mockChatCompletions.mockResolvedValue(makeResponse('done'));

        await runDashboardAgent(
            makeStep(), 'build', '', {}, [], { callTool: jest.fn() }, 10,
            new AbortController().signal, onUpdate3,
            [], '', 'v1',
        );

        const systemMsg = mockChatCompletions.mock.calls[0][0].messages
            .find((m: any) => m.role === 'system')?.content ?? '';
        // v1 schema rules should be present
        expect(systemMsg).toContain('schemaVersion');
        expect(systemMsg).toContain('templating');
        // v2 elements/layout should NOT be present
        expect(systemMsg).not.toContain('"elements"');
        expect(systemMsg).not.toContain('TabsLayout');
    });

    it('uses v2 rules when schemaCapabilityHint is v2-capable', async () => {
        mockChatCompletions.mockResolvedValue(makeResponse('done'));

        await runDashboardAgent(
            makeStep(), 'build', '', {}, [], { callTool: jest.fn() }, 10,
            new AbortController().signal, onUpdate3,
            [], '', 'v2-capable',
        );

        const systemMsg = mockChatCompletions.mock.calls[0][0].messages
            .find((m: any) => m.role === 'system')?.content ?? '';
        // v2 rules present
        expect(systemMsg).toContain('TabsLayout');
        expect(systemMsg).toContain('"elements"');
        // v1 schemaVersion should NOT be the primary instruction
        expect(systemMsg).not.toContain('schemaVersion: 38');
    });

    it('falls back to v1 when update_dashboard returns Kubernetes-not-available error', async () => {
        const k8sError = JSON.stringify([{ text: 'a Kubernetes-capable Grafana is required to save a v2 dashboard' }]);

        mockChatCompletions
            // First response: emit an update_dashboard tool call
            .mockResolvedValueOnce(makeResponse('', [
                makeToolCall('update_dashboard', 'tc1', JSON.stringify({ dashboard: { elements: {}, layout: {} }, overwrite: false }))
            ]))
            // Second response: LLM sees v1 prompt (after fallback) and concludes
            .mockResolvedValueOnce(makeResponse('Fell back to v1 and created dashboard'));

        const mcpClient = {
            callTool: jest.fn().mockResolvedValue({ content: k8sError }),
        };

        const result = await runDashboardAgent(
            makeStep(), 'build', '', {}, [], mcpClient, 10,
            new AbortController().signal, onUpdate3,
            [], '', 'v2-capable',
        );

        // The second LLM call should have received a v1 system prompt (rebuilt after fallback)
        const secondCallSystemMsg = mockChatCompletions.mock.calls[1][0].messages
            .find((m: any) => m.role === 'system')?.content ?? '';
        expect(secondCallSystemMsg).toContain('schemaVersion');
        expect(secondCallSystemMsg).not.toContain('TabsLayout');

        // Summary should mention the fallback
        expect(result.summary).toContain('v1');
        expect(result.status).toBe('success');
    });
});
