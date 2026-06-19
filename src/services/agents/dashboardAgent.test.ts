import { runDashboardAgent, assessDashboardCompleteness } from './dashboardAgent';
import type { PlanStep, DataFindings } from './types';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockChatCompletions = jest.fn();

jest.mock('@grafana/llm', () => ({
    llm: {
        chatCompletions: (...args: any[]) => mockChatCompletions(...args),
        Model: { BASE: 'base', LARGE: 'large' },
    },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

const prometheusFindings: DataFindings = {
    prometheus: {
        datasourceUid: 'prom-uid-456',
        datasourceName: 'Prometheus',
        labels: { job: ['api', 'worker'] },
        validatedQueries: [
            { description: 'Request rate', promql: 'rate(http_requests_total[5m])', unit: 'reqps', suggestedViz: 'timeseries' },
            { description: 'Error rate', promql: 'rate(http_errors_total[5m])', unit: 'reqps', suggestedViz: 'stat' },
        ],
    },
};

/** Build a valid PLAN phase JSON response */
const makePlanResponse = (panels?: any[]) => {
    const defaultPanels = [
        { title: 'Error Log Volume', description: 'Log error rate', query: '{job=~".+"} |= "error"', datasourceType: 'loki', viz: 'timeseries', unit: 'reqps', rowGroup: 'Errors' },
        { title: 'All Logs', description: 'All log streams', query: '{job=~".+"}', datasourceType: 'loki', viz: 'logs', unit: '', rowGroup: 'Logs' },
    ];
    return JSON.stringify({
        panels: panels ?? defaultPanels,
        variables: [],
        timeRange: { from: 'now-1h', to: 'now' },
        layoutHint: 'none',
    });
};

/** Wrap a payload as an MCP content envelope (what mcpClient.callTool returns) */
const mcpEnvelope = (payload: any) => ({
    content: [{ type: 'text', text: JSON.stringify(payload) }],
});

/** Build a get_dashboard_summary envelope */
const makeSummaryEnvelope = (panelCount: number, panels: any[] = []) => mcpEnvelope({
    uid: 'dash-uid-abc',
    title: 'Test Dashboard',
    panelCount,
    panels,
    variables: [],
    timeRange: { from: 'now-1h', to: 'now' },
});

/** Build a get_dashboard_panel_queries envelope */
const makePanelQueriesEnvelope = (queries: any[] = []) => mcpEnvelope(queries);

const makeResponse = (content: string, toolCalls?: any[]) => ({
    choices: [{ message: { content, tool_calls: toolCalls ?? [] } }],
});

const makeToolCall = (name: string, id = 'tc1', args = '{}') => ({
    id,
    function: { name, arguments: args },
});

const makeUpdateDashboardResult = (uid: string) => mcpEnvelope({ uid, status: 'success', version: 1 });

// ─── assessDashboardCompleteness unit tests ───────────────────────────────────

describe('assessDashboardCompleteness', () => {
    const makeSummary = (panels: any[]) => ({
        uid: 'uid',
        title: 'Test',
        panelCount: panels.length,
        panels,
    });

    it('detects empty dashboard (zero panels)', () => {
        const gaps = assessDashboardCompleteness(makeSummary([]), undefined, []);
        expect(gaps.emptyDashboard).toBe(true);
        expect(gaps.livePanelCount).toBe(0);
    });

    it('does not flag as empty when data panels exist', () => {
        const gaps = assessDashboardCompleteness(
            makeSummary([{ id: 1, title: 'CPU', type: 'timeseries', queryCount: 1 }]),
            undefined,
            [],
        );
        expect(gaps.emptyDashboard).toBe(false);
        expect(gaps.livePanelCount).toBe(1);
    });

    it('excludes row panels from the live panel count', () => {
        const gaps = assessDashboardCompleteness(
            makeSummary([
                { id: 1, title: 'Row 1', type: 'row', queryCount: 0 },
                { id: 2, title: 'CPU', type: 'timeseries', queryCount: 1 },
            ]),
            undefined,
            [],
        );
        expect(gaps.emptyDashboard).toBe(false);
        expect(gaps.livePanelCount).toBe(1);
    });

    it('detects planned panels missing from the live dashboard', () => {
        const gaps = assessDashboardCompleteness(
            makeSummary([{ id: 1, title: 'CPU Usage', type: 'timeseries', queryCount: 1 }]),
            undefined,
            ['CPU Usage', 'Memory Usage', 'Network I/O'],
        );
        expect(gaps.missingPanels).toContain('Memory Usage');
        expect(gaps.missingPanels).toContain('Network I/O');
        expect(gaps.missingPanels).not.toContain('CPU Usage');
    });

    it('matches planned panel titles case-insensitively / whitespace-normalised', () => {
        const gaps = assessDashboardCompleteness(
            makeSummary([{ id: 1, title: '  CPU  usage  ', type: 'timeseries', queryCount: 1 }]),
            undefined,
            ['cpu usage'],
        );
        expect(gaps.missingPanels).toHaveLength(0);
    });

    it('detects LogQL query on prometheus datasource (mismatch)', () => {
        const gaps = assessDashboardCompleteness(
            makeSummary([{ id: 1, title: 'Logs', type: 'logs', queryCount: 1 }]),
            [{ title: 'Logs', query: '{job="api"} |= "error"', datasource: { uid: 'p', type: 'prometheus' } }],
            [],
        );
        expect(gaps.datasourceMismatches).toHaveLength(1);
        expect(gaps.datasourceMismatches[0].title).toBe('Logs');
    });

    it('detects PromQL query on loki datasource (mismatch)', () => {
        const gaps = assessDashboardCompleteness(
            makeSummary([{ id: 1, title: 'Rate', type: 'timeseries', queryCount: 1 }]),
            [{ title: 'Rate', query: 'rate(http_requests_total[5m])', datasource: { uid: 'l', type: 'loki' } }],
            [],
        );
        expect(gaps.datasourceMismatches).toHaveLength(1);
        expect(gaps.datasourceMismatches[0].title).toBe('Rate');
    });

    it('does not flag correct prometheus/promql pairing as mismatch', () => {
        const gaps = assessDashboardCompleteness(
            makeSummary([{ id: 1, title: 'Rate', type: 'timeseries', queryCount: 1 }]),
            [{ title: 'Rate', query: 'rate(http_requests_total[5m])', datasource: { uid: 'p', type: 'prometheus' } }],
            [],
        );
        expect(gaps.datasourceMismatches).toHaveLength(0);
    });

    it('flags panels without description', () => {
        const gaps = assessDashboardCompleteness(
            makeSummary([
                { id: 1, title: 'CPU', type: 'timeseries', queryCount: 1 },
                { id: 2, title: 'Memory', type: 'stat', description: 'RAM usage', queryCount: 1 },
            ]),
            undefined,
            [],
        );
        expect(gaps.panelsWithoutDescription).toContain('CPU');
        expect(gaps.panelsWithoutDescription).not.toContain('Memory');
    });

    it('returns no gaps for a fully-correct dashboard', () => {
        const gaps = assessDashboardCompleteness(
            makeSummary([
                { id: 1, title: 'CPU Usage', type: 'timeseries', description: 'CPU over time', queryCount: 1 },
                { id: 2, title: 'Error Rate', type: 'stat', description: 'Error ratio', queryCount: 1 },
            ]),
            [
                { title: 'CPU Usage', query: 'rate(cpu_total[5m])', datasource: { uid: 'p', type: 'prometheus' } },
                { title: 'Error Rate', query: 'rate(errors_total[5m])', datasource: { uid: 'p', type: 'prometheus' } },
            ],
            ['CPU Usage', 'Error Rate'],
        );
        expect(gaps.emptyDashboard).toBe(false);
        expect(gaps.missingPanels).toHaveLength(0);
        expect(gaps.datasourceMismatches).toHaveLength(0);
    });

    it('returns emptyDashboard=true when summary is undefined', () => {
        const gaps = assessDashboardCompleteness(undefined, undefined, ['Panel A']);
        expect(gaps.emptyDashboard).toBe(true);
    });

    it('returns emptyDashboard=true when summary.panels is null (mcp-grafana empty dashboard)', () => {
        // mcp-grafana returns panels:null (not []) when a dashboard has no panels
        const gaps = assessDashboardCompleteness(
            { uid: 'u', title: 'T', panelCount: 0, panels: null as any },
            undefined, ['Panel A'],
        );
        expect(gaps.emptyDashboard).toBe(true);
        expect(gaps.livePanelCount).toBe(0);
    });
});

// ─── runDashboardAgent integration tests ─────────────────────────────────────

describe('runDashboardAgent', () => {
    let mockMcpClient: { callTool: jest.Mock };
    let onUpdate: jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        mockMcpClient = { callTool: jest.fn() };
        onUpdate = jest.fn();
    });

    // ── Core contracts ────────────────────────────────────────────────────

    it('uses Model.LARGE — never Model.BASE', async () => {
        // PLAN response
        mockChatCompletions.mockResolvedValueOnce(makeResponse(makePlanResponse()));
        // CREATE response (no tool calls — agent writes dashboard)
        mockChatCompletions.mockResolvedValueOnce(makeResponse('', [makeToolCall('update_dashboard', 'tc1')]));
        mockChatCompletions.mockResolvedValueOnce(makeResponse('Dashboard created.'));

        mockMcpClient.callTool
            .mockResolvedValueOnce(makeUpdateDashboardResult('uid-abc'))                     // update_dashboard
            .mockResolvedValueOnce(makeSummaryEnvelope(2, [                                  // get_dashboard_summary
                { id: 1, title: 'Error Log Volume', type: 'timeseries', description: 'd', queryCount: 1 },
                { id: 2, title: 'All Logs', type: 'logs', description: 'd', queryCount: 1 },
            ]))
            .mockResolvedValueOnce(makePanelQueriesEnvelope());                              // get_dashboard_panel_queries

        await runDashboardAgent(
            makeStep(), 'build dashboard', '', lokiFindings,
            [], mockMcpClient, 10, new AbortController().signal, onUpdate,
        );

        for (const call of mockChatCompletions.mock.calls) {
            expect(call[0].model).toBe('large');
        }
    });

    it('only passes dashboard and datasource tools — not loki or prometheus', async () => {
        mockChatCompletions.mockResolvedValueOnce(makeResponse(makePlanResponse()));
        mockChatCompletions.mockResolvedValue(makeResponse('done'));
        mockMcpClient.callTool
            .mockResolvedValueOnce(makeUpdateDashboardResult('uid-abc'))
            .mockResolvedValue(makeSummaryEnvelope(2, [
                { id: 1, title: 'Error Log Volume', type: 'timeseries', description: 'd', queryCount: 1 },
                { id: 2, title: 'All Logs', type: 'logs', description: 'd', queryCount: 1 },
            ]));

        const allTools = [
            { type: 'function', function: { name: 'query_loki_logs' } },
            { type: 'function', function: { name: 'query_prometheus' } },
            { type: 'function', function: { name: 'get_dashboard_by_uid' } },
            { type: 'function', function: { name: 'update_dashboard' } },
            { type: 'function', function: { name: 'list_datasources' } },
        ];

        await runDashboardAgent(
            makeStep(), 'build dashboard', '', lokiFindings,
            allTools, mockMcpClient, 10, new AbortController().signal, onUpdate,
        );

        // After PLAN (no tools), CREATE call uses scopedTools
        const createCall = mockChatCompletions.mock.calls[1][0];
        const toolNames = createCall.tools?.map((t: any) => t.function.name) ?? [];
        expect(toolNames).toContain('get_dashboard_by_uid');
        expect(toolNames).toContain('update_dashboard');
        expect(toolNames).toContain('list_datasources');
        expect(toolNames).not.toContain('query_loki_logs');
        expect(toolNames).not.toContain('query_prometheus');
    });

    it('includes validated Loki queries in the CREATE phase system prompt', async () => {
        mockChatCompletions.mockResolvedValueOnce(makeResponse(makePlanResponse()));
        mockChatCompletions.mockResolvedValue(makeResponse('done'));
        mockMcpClient.callTool
            .mockResolvedValue(makeSummaryEnvelope(2, [
                { id: 1, title: 'Error Log Volume', type: 'timeseries', description: 'd', queryCount: 1 },
                { id: 2, title: 'All Logs', type: 'logs', description: 'd', queryCount: 1 },
            ]));

        await runDashboardAgent(
            makeStep(), 'build dashboard', '', lokiFindings,
            [], mockMcpClient, 10, new AbortController().signal, onUpdate,
        );

        // CREATE prompt (call index 1 = after PLAN)
        const createSystemMsg = mockChatCompletions.mock.calls[1][0].messages
            .find((m: any) => m.role === 'system')?.content ?? '';
        expect(createSystemMsg).toContain('loki-uid-123');
        expect(createSystemMsg).toContain('{job=~".+"} |= "error" | logfmt');
        expect(createSystemMsg).toContain('Error log volume by service');
    });

    it('returns success result with summary', async () => {
        mockChatCompletions.mockResolvedValueOnce(makeResponse(makePlanResponse()));
        mockChatCompletions
            .mockResolvedValueOnce(makeResponse('', [makeToolCall('update_dashboard', 'tc1')]))
            .mockResolvedValueOnce(makeResponse('Dashboard created: [Open](/d/abc123). 2 panels added.'));

        mockMcpClient.callTool
            .mockResolvedValueOnce(makeUpdateDashboardResult('abc123'))
            .mockResolvedValueOnce(makeSummaryEnvelope(2, [
                { id: 1, title: 'Error Log Volume', type: 'timeseries', description: 'd', queryCount: 1 },
                { id: 2, title: 'All Logs', type: 'logs', description: 'd', queryCount: 1 },
            ]))
            .mockResolvedValueOnce(makePanelQueriesEnvelope());

        const result = await runDashboardAgent(
            makeStep(), 'build dashboard', '', lokiFindings,
            [], mockMcpClient, 10, new AbortController().signal, onUpdate,
        );

        expect(result.status).toBe('success');
        expect(result.stepId).toBe('step_3');
        expect(result.dashboardUid).toBe('abc123');
    });

    it('executes tool calls and calls onUpdate', async () => {
        const toolCall = makeToolCall('update_dashboard', 'tc1');
        mockChatCompletions
            .mockResolvedValueOnce(makeResponse(makePlanResponse()))
            .mockResolvedValueOnce(makeResponse('', [toolCall]))
            .mockResolvedValueOnce(makeResponse('Dashboard saved.'));

        mockMcpClient.callTool
            .mockResolvedValueOnce(makeUpdateDashboardResult('uid-xyz'))
            .mockResolvedValueOnce(makeSummaryEnvelope(2, [
                { id: 1, title: 'Error Log Volume', type: 'timeseries', description: 'd', queryCount: 1 },
                { id: 2, title: 'All Logs', type: 'logs', description: 'd', queryCount: 1 },
            ]))
            .mockResolvedValueOnce(makePanelQueriesEnvelope());

        await runDashboardAgent(
            makeStep(), 'build', '', lokiFindings,
            [{ type: 'function', function: { name: 'update_dashboard' } }],
            mockMcpClient, 10, new AbortController().signal, onUpdate,
        );

        expect(mockMcpClient.callTool).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'update_dashboard' })
        );
        expect(onUpdate).toHaveBeenCalledWith('step_3', expect.arrayContaining([
            expect.objectContaining({ name: 'update_dashboard', status: 'pending' }),
        ]));
    });

    it('returns error result on LLM failure without throwing', async () => {
        mockChatCompletions.mockRejectedValue(new Error('LARGE model unavailable'));

        const result = await runDashboardAgent(
            makeStep(), 'build', '', lokiFindings,
            [], mockMcpClient, 10, new AbortController().signal, onUpdate,
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
                mockMcpClient, 10, controller.signal, onUpdate,
            )
        ).rejects.toThrow('Aborted');
    });

    it('works with empty DataFindings (no upstream data)', async () => {
        mockChatCompletions.mockResolvedValue(makeResponse(JSON.stringify({ panels: [
            { title: 'Panel A', description: 'desc', query: '{job="api"}', datasourceType: 'loki', viz: 'timeseries', unit: '', rowGroup: 'Logs' },
        ], variables: [], timeRange: { from: 'now-1h', to: 'now' } })));

        const result = await runDashboardAgent(
            makeStep(), 'organise dashboards', '', {},
            [], mockMcpClient, 10, new AbortController().signal, onUpdate,
        );

        expect(result.status).toBe('success');
        // CREATE phase prompt should contain no-findings guidance
        const createSystemMsg = mockChatCompletions.mock.calls[1]?.[0]?.messages
            .find((m: any) => m.role === 'system')?.content ?? '';
        expect(createSystemMsg).toContain('No pre-validated queries were provided');
    });

    // ── PLAN phase ────────────────────────────────────────────────────────

    it('PLAN phase: emits panel todo list as first LLM call (no tools)', async () => {
        mockChatCompletions.mockResolvedValue(makeResponse(makePlanResponse()));
        mockMcpClient.callTool.mockResolvedValue(makeSummaryEnvelope(2, [
            { id: 1, title: 'Error Log Volume', type: 'timeseries', description: 'd', queryCount: 1 },
            { id: 2, title: 'All Logs', type: 'logs', description: 'd', queryCount: 1 },
        ]));

        await runDashboardAgent(
            makeStep(), 'build dashboard', '', lokiFindings,
            [], mockMcpClient, 10, new AbortController().signal, onUpdate,
        );

        // PLAN is the first chatCompletions call; it should have NO tools (pure planning)
        const planCall = mockChatCompletions.mock.calls[0][0];
        expect(planCall.tools).toBeUndefined();
        expect(planCall.model).toBe('large');
    });

    it('PLAN phase: prompt instructs JSON panel todo list output format', async () => {
        mockChatCompletions.mockResolvedValue(makeResponse(makePlanResponse()));
        mockMcpClient.callTool.mockResolvedValue(makeSummaryEnvelope(2, [
            { id: 1, title: 'Error Log Volume', type: 'timeseries', description: 'd', queryCount: 1 },
            { id: 2, title: 'All Logs', type: 'logs', description: 'd', queryCount: 1 },
        ]));

        await runDashboardAgent(
            makeStep(), 'build dashboard', '', lokiFindings,
            [], mockMcpClient, 10, new AbortController().signal, onUpdate,
        );

        const planSystemMsg = mockChatCompletions.mock.calls[0][0].messages
            .find((m: any) => m.role === 'system')?.content ?? '';
        // Must mention the todo list / completeness contract
        expect(planSystemMsg).toContain('panels');
        expect(planSystemMsg).toContain('rowGroup');
        expect(planSystemMsg).toContain('datasourceType');
    });

    it('PLAN phase: passes validated queries into the plan prompt', async () => {
        mockChatCompletions.mockResolvedValue(makeResponse(makePlanResponse()));
        mockMcpClient.callTool.mockResolvedValue(makeSummaryEnvelope(2, [
            { id: 1, title: 'Error Log Volume', type: 'timeseries', description: 'd', queryCount: 1 },
            { id: 2, title: 'All Logs', type: 'logs', description: 'd', queryCount: 1 },
        ]));

        await runDashboardAgent(
            makeStep(), 'build', '', lokiFindings, [], mockMcpClient, 10,
            new AbortController().signal, onUpdate,
        );

        const planSystemMsg = mockChatCompletions.mock.calls[0][0].messages
            .find((m: any) => m.role === 'system')?.content ?? '';
        expect(planSystemMsg).toContain('loki-uid-123');
        expect(planSystemMsg).toContain('{job=~".+"} |= "error" | logfmt');
    });

    // ── CREATE phase ─────────────────────────────────────────────────────

    it('CREATE phase: prompt instructs skeleton → rows → panels sequence', async () => {
        mockChatCompletions
            .mockResolvedValueOnce(makeResponse(makePlanResponse()))
            .mockResolvedValue(makeResponse('done'));
        mockMcpClient.callTool.mockResolvedValue(makeSummaryEnvelope(2, [
            { id: 1, title: 'Error Log Volume', type: 'timeseries', description: 'd', queryCount: 1 },
            { id: 2, title: 'All Logs', type: 'logs', description: 'd', queryCount: 1 },
        ]));

        await runDashboardAgent(
            makeStep(), 'build dashboard', '', lokiFindings,
            [], mockMcpClient, 10, new AbortController().signal, onUpdate,
        );

        const createSystemMsg = mockChatCompletions.mock.calls[1][0].messages
            .find((m: any) => m.role === 'system')?.content ?? '';
        // Must describe the 3-step sequence
        expect(createSystemMsg).toContain('Step 1');
        expect(createSystemMsg).toContain('Step 2');
        expect(createSystemMsg).toContain('Step 3');
        // Step 1 must be skeleton with empty panels
        expect(createSystemMsg).toContain('panels: []');
        // Step 2 must be row panels via patch
        expect(createSystemMsg).toContain('$.panels/- ');
        // Step 3 must be data panels per row
        expect(createSystemMsg).toContain('data panels');
        // Must explicitly prohibit panel_queries/summary in the CREATE phase
        expect(createSystemMsg).toContain('DO NOT call get_dashboard_panel_queries');
    });

    it('CREATE phase: panel todo list titles appear in the create prompt', async () => {
        const customPanels = [
            { title: 'CPU Usage', description: 'cpu over time', query: 'rate(cpu_total[5m])', datasourceType: 'prometheus', viz: 'timeseries', unit: 'percentunit', rowGroup: 'Compute' },
            { title: 'Memory Usage', description: 'mem used', query: 'container_memory_usage_bytes', datasourceType: 'prometheus', viz: 'stat', unit: 'bytes', rowGroup: 'Compute' },
        ];
        mockChatCompletions
            .mockResolvedValueOnce(makeResponse(makePlanResponse(customPanels)))
            .mockResolvedValue(makeResponse('done'));
        mockMcpClient.callTool.mockResolvedValue(makeSummaryEnvelope(2, [
            { id: 1, title: 'CPU Usage', type: 'timeseries', description: 'd', queryCount: 1 },
            { id: 2, title: 'Memory Usage', type: 'stat', description: 'd', queryCount: 1 },
        ]));

        await runDashboardAgent(
            makeStep({ description: 'Build compute dashboard' }),
            'build dashboard', '', prometheusFindings,
            [], mockMcpClient, 10, new AbortController().signal, onUpdate,
        );

        const createSystemMsg = mockChatCompletions.mock.calls[1][0].messages
            .find((m: any) => m.role === 'system')?.content ?? '';
        expect(createSystemMsg).toContain('CPU Usage');
        expect(createSystemMsg).toContain('Memory Usage');
    });

    it('CREATE phase: uses folderUid (not folderId) in the dashboard skeleton', async () => {
        mockChatCompletions
            .mockResolvedValueOnce(makeResponse(makePlanResponse()))
            .mockResolvedValue(makeResponse('done'));
        mockMcpClient.callTool.mockResolvedValue(makeSummaryEnvelope(2, [
            { id: 1, title: 'Error Log Volume', type: 'timeseries', description: 'd', queryCount: 1 },
            { id: 2, title: 'All Logs', type: 'logs', description: 'd', queryCount: 1 },
        ]));

        await runDashboardAgent(
            makeStep(), 'build dashboard', '', lokiFindings,
            [], mockMcpClient, 10, new AbortController().signal, onUpdate,
        );

        const createSystemMsg = mockChatCompletions.mock.calls[1][0].messages
            .find((m: any) => m.role === 'system')?.content ?? '';
        expect(createSystemMsg).toContain('folderUid');
        expect(createSystemMsg).not.toContain('"folderId"');
    });

    // ── VERIFY + REPAIR ───────────────────────────────────────────────────

    it('REGRESSION: empty skeleton → VERIFY detects 0 panels → REPAIR fills them', async () => {
        // PLAN phase
        mockChatCompletions.mockResolvedValueOnce(makeResponse(makePlanResponse([
            { title: 'Error Logs', description: 'err', query: '{job="api"} |= "error"', datasourceType: 'loki', viz: 'logs', unit: '', rowGroup: 'Logs' },
        ])));

        // CREATE phase: agent emits update_dashboard with empty panels (the regression)
        mockChatCompletions
            .mockResolvedValueOnce(makeResponse('', [
                makeToolCall('update_dashboard', 'tc1', JSON.stringify({ dashboard: { title: 'Test', panels: [] }, overwrite: false })),
            ]))
            .mockResolvedValueOnce(makeResponse('Skeleton created.'));

        // REPAIR phase: agent does full-JSON rewrite (not patches — patch fails on null panels array)
        mockChatCompletions
            .mockResolvedValueOnce(makeResponse('', [
                makeToolCall('update_dashboard', 'tc2', JSON.stringify({
                    dashboard: { title: 'OTel Monitoring', uid: 'uid-abc', panels: [
                        { id: 1, type: 'logs', title: 'Error Logs', description: 'err', gridPos: { h: 8, w: 24, x: 0, y: 0 }, targets: [{ expr: '{job="api"} |= "error"', datasource: { type: 'loki', uid: 'loki-uid-123' }, legendFormat: 'errors' }] },
                    ], schemaVersion: 38 },
                    overwrite: true,
                })),
            ]))
            .mockResolvedValueOnce(makeResponse('Panels added.'));

        mockMcpClient.callTool
            .mockResolvedValueOnce(makeUpdateDashboardResult('uid-abc'))       // CREATE update_dashboard → empty skeleton saved
            .mockResolvedValueOnce(makeSummaryEnvelope(0, []))                 // VERIFY: get_dashboard_summary → 0 panels (no panel_queries call)
            // NOTE: get_dashboard_panel_queries is NOT called when panelCount=0
            .mockResolvedValueOnce(makeUpdateDashboardResult('uid-abc'))       // REPAIR update_dashboard (full-JSON rewrite with panels)
            .mockResolvedValueOnce(makeSummaryEnvelope(1, [                    // 2nd VERIFY after repair
                { id: 1, title: 'Error Logs', type: 'logs', description: 'err', queryCount: 1 },
            ]))
            .mockResolvedValueOnce(makePanelQueriesEnvelope([                   // 2nd VERIFY panel queries (panelCount=1, called now)
                { title: 'Error Logs', query: '{job="api"} |= "error"', datasource: { uid: 'loki-uid-123', type: 'loki' } },
            ]));

        const result = await runDashboardAgent(
            makeStep(), 'build', '', lokiFindings,
            [
                { type: 'function', function: { name: 'update_dashboard' } },
                { type: 'function', function: { name: 'get_dashboard_summary' } },
                { type: 'function', function: { name: 'get_dashboard_panel_queries' } },
            ],
            mockMcpClient, 20, new AbortController().signal, onUpdate,
        );

        // Must have issued a REPAIR update_dashboard to fix the empty skeleton
        const updateCalls = mockMcpClient.callTool.mock.calls
            .filter((c: any[]) => c[0].name === 'update_dashboard');
        expect(updateCalls.length).toBeGreaterThanOrEqual(2);

        // Final result must be success, not an empty-dashboard error
        expect(result.status).toBe('success');
        expect(result.dashboardUid).toBe('uid-abc');
    });

    it('REPAIR: retries update_dashboard when it returns an error', async () => {
        mockChatCompletions.mockResolvedValueOnce(makeResponse(makePlanResponse()));

        // CREATE: agent emits update_dashboard — first attempt errors, second succeeds
        mockChatCompletions
            .mockResolvedValueOnce(makeResponse('', [makeToolCall('update_dashboard', 'tc1')]))
            .mockResolvedValueOnce(makeResponse('', [makeToolCall('update_dashboard', 'tc2')]))
            .mockResolvedValueOnce(makeResponse('Dashboard saved.'));

        const errorEnv = { content: [{ type: 'text', text: 'Error: validation failed' }], isError: true };
        mockMcpClient.callTool
            .mockResolvedValueOnce(errorEnv)                                    // tc1 fails
            .mockResolvedValueOnce(makeUpdateDashboardResult('uid-retry'))      // tc2 succeeds
            .mockResolvedValueOnce(makeSummaryEnvelope(2, [                    // VERIFY
                { id: 1, title: 'Error Log Volume', type: 'timeseries', description: 'd', queryCount: 1 },
                { id: 2, title: 'All Logs', type: 'logs', description: 'd', queryCount: 1 },
            ]))
            .mockResolvedValueOnce(makePanelQueriesEnvelope());

        const result = await runDashboardAgent(
            makeStep(), 'build', '', lokiFindings,
            [{ type: 'function', function: { name: 'update_dashboard' } }],
            mockMcpClient, 20, new AbortController().signal, onUpdate,
        );

        expect(result.status).toBe('success');
        expect(result.dashboardUid).toBe('uid-retry');
    });

    it('VERIFY: calls get_dashboard_summary and get_dashboard_panel_queries after create', async () => {
        mockChatCompletions
            .mockResolvedValueOnce(makeResponse(makePlanResponse()))
            .mockResolvedValueOnce(makeResponse('', [makeToolCall('update_dashboard', 'tc1')]))
            .mockResolvedValueOnce(makeResponse('Done.'));

        mockMcpClient.callTool
            .mockResolvedValueOnce(makeUpdateDashboardResult('uid-verify'))
            .mockResolvedValueOnce(makeSummaryEnvelope(2, [
                { id: 1, title: 'Error Log Volume', type: 'timeseries', description: 'd', queryCount: 1 },
                { id: 2, title: 'All Logs', type: 'logs', description: 'd', queryCount: 1 },
            ]))
            .mockResolvedValueOnce(makePanelQueriesEnvelope());

        await runDashboardAgent(
            makeStep(), 'build', '', lokiFindings,
            [{ type: 'function', function: { name: 'update_dashboard' } }],
            mockMcpClient, 10, new AbortController().signal, onUpdate,
        );

        const callNames = mockMcpClient.callTool.mock.calls.map((c: any[]) => c[0].name);
        expect(callNames).toContain('get_dashboard_summary');
        expect(callNames).toContain('get_dashboard_panel_queries');
    });

    it('no gaps after create: does NOT enter REPAIR (clean exit)', async () => {
        mockChatCompletions
            .mockResolvedValueOnce(makeResponse(makePlanResponse([
                { title: 'Error Log Volume', description: 'd', query: '{job=~".+"} |= "error"', datasourceType: 'loki', viz: 'timeseries', unit: '', rowGroup: 'Row' },
                { title: 'All Logs', description: 'd', query: '{job=~".+"}', datasourceType: 'loki', viz: 'logs', unit: '', rowGroup: 'Row' },
            ])))
            .mockResolvedValueOnce(makeResponse('', [makeToolCall('update_dashboard', 'tc1')]))
            .mockResolvedValueOnce(makeResponse('Done.'));

        mockMcpClient.callTool
            .mockResolvedValueOnce(makeUpdateDashboardResult('uid-clean'))
            .mockResolvedValueOnce(makeSummaryEnvelope(2, [
                { id: 1, title: 'Error Log Volume', type: 'timeseries', description: 'd', queryCount: 1 },
                { id: 2, title: 'All Logs', type: 'logs', description: 'd', queryCount: 1 },
            ]))
            .mockResolvedValueOnce(makePanelQueriesEnvelope([
                { title: 'Error Log Volume', query: '{job=~".+"} |= "error"', datasource: { uid: 'loki-uid-123', type: 'loki' } },
                { title: 'All Logs', query: '{job=~".+"}', datasource: { uid: 'loki-uid-123', type: 'loki' } },
            ]));

        const result = await runDashboardAgent(
            makeStep(), 'build', '', lokiFindings,
            [{ type: 'function', function: { name: 'update_dashboard' } }],
            mockMcpClient, 10, new AbortController().signal, onUpdate,
        );

        // Only one update_dashboard call (the CREATE) — no REPAIR
        const updateCalls = mockMcpClient.callTool.mock.calls
            .filter((c: any[]) => c[0].name === 'update_dashboard');
        expect(updateCalls).toHaveLength(1);
        expect(result.status).toBe('success');
    });

    it('datasource mismatch: REPAIR issues corrective update_dashboard', async () => {
        mockChatCompletions
            .mockResolvedValueOnce(makeResponse(makePlanResponse([
                { title: 'Logs', description: 'log stream', query: '{job="api"} |= "error"', datasourceType: 'loki', viz: 'logs', unit: '', rowGroup: 'Logs' },
            ])))
            .mockResolvedValueOnce(makeResponse('', [makeToolCall('update_dashboard', 'tc1')]))
            .mockResolvedValueOnce(makeResponse('created'))
            // REPAIR phase
            .mockResolvedValueOnce(makeResponse('', [makeToolCall('update_dashboard', 'tc2',
                JSON.stringify({ uid: 'uid-mismatch', operations: [{ op: 'replace', path: '$.panels[0].targets[0].datasource', value: { type: 'loki', uid: 'loki-uid-123' } }], overwrite: true }))]))
            .mockResolvedValueOnce(makeResponse('Fixed mismatch.'));

        mockMcpClient.callTool
            .mockResolvedValueOnce(makeUpdateDashboardResult('uid-mismatch'))
            // VERIFY 1: datasource mismatch — loki query on prometheus datasource
            .mockResolvedValueOnce(makeSummaryEnvelope(1, [{ id: 1, title: 'Logs', type: 'logs', description: 'd', queryCount: 1 }]))
            .mockResolvedValueOnce(makePanelQueriesEnvelope([
                { title: 'Logs', query: '{job="api"} |= "error"', datasource: { uid: 'p', type: 'prometheus' } },
            ]))
            // REPAIR update_dashboard
            .mockResolvedValueOnce(makeUpdateDashboardResult('uid-mismatch'))
            // VERIFY 2: clean
            .mockResolvedValueOnce(makeSummaryEnvelope(1, [{ id: 1, title: 'Logs', type: 'logs', description: 'd', queryCount: 1 }]))
            .mockResolvedValueOnce(makePanelQueriesEnvelope([
                { title: 'Logs', query: '{job="api"} |= "error"', datasource: { uid: 'loki-uid-123', type: 'loki' } },
            ]));

        const result = await runDashboardAgent(
            makeStep(), 'build', '', lokiFindings,
            [{ type: 'function', function: { name: 'update_dashboard' } }],
            mockMcpClient, 30, new AbortController().signal, onUpdate,
        );

        const updateCalls = mockMcpClient.callTool.mock.calls
            .filter((c: any[]) => c[0].name === 'update_dashboard');
        expect(updateCalls.length).toBeGreaterThanOrEqual(2);
        expect(result.status).toBe('success');
    });

    // ── Directional hints / empty findings ───────────────────────────────

    it('emits Prometheus directive in PLAN prompt when preferredCategories is [prometheus] and findings empty', async () => {
        mockChatCompletions.mockResolvedValue(makeResponse(JSON.stringify({ panels: [
            { title: 'Panel A', description: 'desc', query: 'rate(cpu[5m])', datasourceType: 'prometheus', viz: 'timeseries', unit: 'reqps', rowGroup: 'Compute' },
        ], variables: [], timeRange: { from: 'now-1h', to: 'now' } })));

        await runDashboardAgent(
            makeStep(), 'build a service monitoring dashboard', '', {},
            [], mockMcpClient, 10, new AbortController().signal, onUpdate,
            ['prometheus'],
        );

        const planSystemMsg = mockChatCompletions.mock.calls[0][0].messages
            .find((m: any) => m.role === 'system')?.content ?? '';
        expect(planSystemMsg).toContain('Prometheus metrics');
        expect(planSystemMsg).toContain('PromQL');
        expect(planSystemMsg).toMatch(/Do NOT use a Loki datasource/i);
    });

    it('emits Loki directive in PLAN prompt when preferredCategories is [loki] and findings empty', async () => {
        mockChatCompletions.mockResolvedValue(makeResponse(JSON.stringify({ panels: [
            { title: 'Logs', description: 'd', query: '{job="api"}', datasourceType: 'loki', viz: 'logs', unit: '', rowGroup: 'Logs' },
        ], variables: [], timeRange: { from: 'now-1h', to: 'now' } })));

        await runDashboardAgent(
            makeStep(), 'build a log monitoring dashboard', '', {},
            [], mockMcpClient, 10, new AbortController().signal, onUpdate,
            ['loki'],
        );

        const planSystemMsg = mockChatCompletions.mock.calls[0][0].messages
            .find((m: any) => m.role === 'system')?.content ?? '';
        expect(planSystemMsg).toContain('Loki logs');
        expect(planSystemMsg).toContain('LogQL');
        expect(planSystemMsg).toMatch(/Do NOT use a Prometheus datasource/i);
    });

    it('directional hint does NOT override pre-validated findings', async () => {
        mockChatCompletions.mockResolvedValue(makeResponse(makePlanResponse()));
        mockMcpClient.callTool.mockResolvedValue(makeSummaryEnvelope(2, [
            { id: 1, title: 'Error Log Volume', type: 'timeseries', description: 'd', queryCount: 1 },
            { id: 2, title: 'All Logs', type: 'logs', description: 'd', queryCount: 1 },
        ]));

        await runDashboardAgent(
            makeStep(), 'build dashboard', '', lokiFindings,
            [], mockMcpClient, 10, new AbortController().signal, onUpdate,
            ['prometheus'], // hint says prometheus, but findings are loki
        );

        const planSystemMsg = mockChatCompletions.mock.calls[0][0].messages
            .find((m: any) => m.role === 'system')?.content ?? '';
        // Should show the pre-validated Loki findings, not the empty-findings directive
        expect(planSystemMsg).toContain('loki-uid-123');
        expect(planSystemMsg).not.toContain('No pre-validated queries were provided');
    });

    // ── Conversation digest ────────────────────────────────────────────────

    it('embeds conversation digest in the PLAN system prompt when provided', async () => {
        mockChatCompletions.mockResolvedValue(makeResponse(makePlanResponse()));
        mockMcpClient.callTool.mockResolvedValue(makeSummaryEnvelope(2, [
            { id: 1, title: 'Error Log Volume', type: 'timeseries', description: 'd', queryCount: 1 },
            { id: 2, title: 'All Logs', type: 'logs', description: 'd', queryCount: 1 },
        ]));

        const digest = 'User: Which services?\nAssistant: graft-plugin-frontend via Prometheus.';

        await runDashboardAgent(
            makeStep(), 'build a dashboard to monitor it', '', {},
            [], mockMcpClient, 10, new AbortController().signal, onUpdate,
            ['prometheus'], digest,
        );

        const planSystemMsg = mockChatCompletions.mock.calls[0][0].messages
            .find((m: any) => m.role === 'system')?.content ?? '';
        expect(planSystemMsg).toContain('graft-plugin-frontend via Prometheus');
        expect(planSystemMsg).toContain('Recent conversation');
    });

    // ── V2 capability probe ────────────────────────────────────────────────

    it('uses v1 rules when schemaCapabilityHint is v1 (default)', async () => {
        mockChatCompletions
            .mockResolvedValueOnce(makeResponse(makePlanResponse()))
            .mockResolvedValue(makeResponse('done'));
        mockMcpClient.callTool.mockResolvedValue(makeSummaryEnvelope(2, [
            { id: 1, title: 'Error Log Volume', type: 'timeseries', description: 'd', queryCount: 1 },
            { id: 2, title: 'All Logs', type: 'logs', description: 'd', queryCount: 1 },
        ]));

        await runDashboardAgent(
            makeStep(), 'build', '', {}, [], { callTool: jest.fn().mockResolvedValue(makeSummaryEnvelope(0, [])) }, 10,
            new AbortController().signal, onUpdate, [], '', 'v1',
        );

        const createSystemMsg = mockChatCompletions.mock.calls[1][0].messages
            .find((m: any) => m.role === 'system')?.content ?? '';
        expect(createSystemMsg).toContain('schemaVersion');
        expect(createSystemMsg).toContain('templating');
        expect(createSystemMsg).not.toContain('TabsLayout');
        expect(createSystemMsg).not.toContain('"elements"');
    });

    it('uses v2 rules when schemaCapabilityHint is v2-capable', async () => {
        mockChatCompletions
            .mockResolvedValueOnce(makeResponse(makePlanResponse()))
            .mockResolvedValue(makeResponse('done'));

        await runDashboardAgent(
            makeStep(), 'build', '', {}, [], { callTool: jest.fn().mockResolvedValue(makeSummaryEnvelope(0, [])) }, 10,
            new AbortController().signal, onUpdate, [], '', 'v2-capable',
        );

        const createSystemMsg = mockChatCompletions.mock.calls[1][0].messages
            .find((m: any) => m.role === 'system')?.content ?? '';
        expect(createSystemMsg).toContain('TabsLayout');
        expect(createSystemMsg).toContain('elements/layout');
    });

    it('falls back to v1 when update_dashboard returns Kubernetes-not-available error', async () => {
        const k8sError = JSON.stringify([{ text: 'a Kubernetes-capable Grafana is required to save a v2 dashboard' }]);

        mockChatCompletions
            .mockResolvedValueOnce(makeResponse(makePlanResponse()))
            .mockResolvedValueOnce(makeResponse('', [
                makeToolCall('update_dashboard', 'tc1', JSON.stringify({ dashboard: { elements: {}, layout: {} }, overwrite: false })),
            ]))
            .mockResolvedValueOnce(makeResponse('', [
                makeToolCall('update_dashboard', 'tc2', JSON.stringify({ dashboard: { title: 'Test', panels: [] }, overwrite: false })),
            ]))
            .mockResolvedValueOnce(makeResponse('Fell back to v1 and created dashboard'));

        const mcpClient = {
            callTool: jest.fn()
                .mockResolvedValueOnce({ content: k8sError })                  // tc1 — V2 write fails
                .mockResolvedValueOnce(makeUpdateDashboardResult('uid-v1'))     // tc2 — v1 write succeeds
                .mockResolvedValue(makeSummaryEnvelope(2, [                    // VERIFY
                    { id: 1, title: 'Error Log Volume', type: 'timeseries', description: 'd', queryCount: 1 },
                    { id: 2, title: 'All Logs', type: 'logs', description: 'd', queryCount: 1 },
                ])),
        };

        const result = await runDashboardAgent(
            makeStep(), 'build', '', {}, [], mcpClient, 10,
            new AbortController().signal, onUpdate, [], '', 'v2-capable',
        );

        // After fallback, the next LLM call should receive a v1 prompt
        const postFallbackMsg = mockChatCompletions.mock.calls[2][0].messages
            .find((m: any) => m.role === 'system')?.content ?? '';
        expect(postFallbackMsg).toContain('schemaVersion');
        expect(postFallbackMsg).not.toContain('TabsLayout');

        expect(result.summary).toContain('v1');
        expect(result.status).toBe('success');
    });

    // ── NO_COMPRESS (dashboard JSON must never be compressed) ─────────────

    it('does NOT compress update_dashboard or get_dashboard_summary results', async () => {
        const tc1 = makeToolCall('get_dashboard_by_uid', 'tc1');
        const tc2 = makeToolCall('update_dashboard', 'tc2');
        const dashJson = JSON.stringify([{ type: 'text', text: JSON.stringify({ uid: 'abc', panels: [] }) }]);

        mockChatCompletions
            .mockResolvedValueOnce(makeResponse(makePlanResponse()))
            .mockResolvedValueOnce(makeResponse('', [tc1]))
            .mockResolvedValueOnce(makeResponse('', [tc2]))
            .mockResolvedValueOnce(makeResponse('Done.'));

        mockMcpClient.callTool
            .mockResolvedValueOnce({ content: JSON.parse(dashJson) })          // get_dashboard_by_uid
            .mockResolvedValueOnce(makeUpdateDashboardResult('abc'))           // update_dashboard
            .mockResolvedValueOnce(makeSummaryEnvelope(2, [                   // VERIFY summary
                { id: 1, title: 'Error Log Volume', type: 'timeseries', description: 'd', queryCount: 1 },
                { id: 2, title: 'All Logs', type: 'logs', description: 'd', queryCount: 1 },
            ]))
            .mockResolvedValueOnce(makePanelQueriesEnvelope());

        await runDashboardAgent(
            makeStep(), 'build', '', lokiFindings,
            [
                { type: 'function', function: { name: 'get_dashboard_by_uid' } },
                { type: 'function', function: { name: 'update_dashboard' } },
            ],
            mockMcpClient, 10, new AbortController().signal, onUpdate,
        );

        // The LLM call AFTER get_dashboard_by_uid should still see the full result (not compressed)
        const secondCreateCallMessages = mockChatCompletions.mock.calls[2][0].messages;
        const dashMsg = secondCreateCallMessages.find((m: any) => m.tool_call_id === 'tc1');
        expect(dashMsg).toBeDefined();
        expect(dashMsg.content).toContain('panels');     // full result preserved, not compressed
    });

    // ── Enrichment integration ────────────────────────────────────────────

    it('applies deterministic enrichment — inferred unit appears in PLAN prompt', async () => {
        mockChatCompletions.mockResolvedValue(makeResponse(makePlanResponse()));
        mockMcpClient.callTool.mockResolvedValue(makeSummaryEnvelope(2, [
            { id: 1, title: 'Error Log Volume', type: 'timeseries', description: 'd', queryCount: 1 },
            { id: 2, title: 'All Logs', type: 'logs', description: 'd', queryCount: 1 },
        ]));

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
            [], mockMcpClient, 10, new AbortController().signal, onUpdate,
        );

        const planSystemMsg = mockChatCompletions.mock.calls[0][0].messages
            .find((m: any) => m.role === 'system')?.content ?? '';
        // Enrichment should have derived unit: reqps for rate(_total)
        expect(planSystemMsg).toContain('reqps');
    });

    it('datasource-only findings: PLAN prompt shows datasource uid', async () => {
        mockChatCompletions.mockResolvedValue(makeResponse(JSON.stringify({
            panels: [{ title: 'Panel A', description: 'd', query: 'rate(cpu[5m])', datasourceType: 'prometheus', viz: 'timeseries', unit: '', rowGroup: 'Compute' }],
            variables: [], timeRange: { from: 'now-1h', to: 'now' },
        })));
        mockMcpClient.callTool.mockResolvedValue(makeSummaryEnvelope(1, [
            { id: 1, title: 'Panel A', type: 'timeseries', description: 'd', queryCount: 1 },
        ]));

        const datasourceOnlyFindings: DataFindings = {
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

        const planSystemMsg = mockChatCompletions.mock.calls[0][0].messages
            .find((m: any) => m.role === 'system')?.content ?? '';
        expect(planSystemMsg).toContain('prom-uid-456');
        expect(planSystemMsg).toContain('Datasource identified');
    });
});
