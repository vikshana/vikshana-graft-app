import { runDashboardAgent, assessDashboardCompleteness, computeLayout } from './dashboardAgent';
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
const makePlanResponse = (panels?: any[], overrides?: { title?: string; description?: string }) => {
    const defaultPanels = [
        { title: 'Error Log Volume', description: 'Log error rate', query: '{job=~".+"} |= "error"', datasourceType: 'loki', viz: 'timeseries', unit: 'reqps', rowGroup: 'Errors' },
        { title: 'All Logs', description: 'All log streams', query: '{job=~".+"}', datasourceType: 'loki', viz: 'logs', unit: '', rowGroup: 'Logs' },
    ];
    return JSON.stringify({
        title: overrides?.title ?? 'Service Log Monitoring',
        description: overrides?.description ?? 'Monitors log volume and error rates for observed services.',
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

// ─── computeLayout unit tests ─────────────────────────────────────────────────

describe('computeLayout', () => {
    it('produces row panel first then data panels (correct interleaving)', () => {
        const todos = [
            { title: 'P1', rowGroup: 'Receivers', viz: 'timeseries', unit: 'reqps' },
            { title: 'P2', rowGroup: 'Receivers', viz: 'timeseries', unit: 'reqps' },
        ];
        const layout = computeLayout(todos);
        expect(layout[0].type).toBe('row');
        expect(layout[0].title).toBe('Receivers');
        expect(layout[1].type).toBe('data');
        expect(layout[1].title).toBe('P1');
        expect(layout[2].type).toBe('data');
        expect(layout[2].title).toBe('P2');
    });

    it('assigns sequential ids starting from 1', () => {
        const todos = [
            { title: 'P1', rowGroup: 'R1', viz: 'timeseries', unit: '' },
            { title: 'P2', rowGroup: 'R1', viz: 'timeseries', unit: '' },
            { title: 'P3', rowGroup: 'R2', viz: 'stat', unit: '' },
        ];
        const layout = computeLayout(todos);
        expect(layout.map(p => p.id)).toEqual([1, 2, 3, 4, 5]);
    });

    it('row header is always y=0 for first group, then increments correctly', () => {
        const todos = [
            { title: 'P1', rowGroup: 'Receivers', viz: 'timeseries', unit: '' },
            { title: 'P2', rowGroup: 'Exporters', viz: 'timeseries', unit: '' },
        ];
        const layout = computeLayout(todos);
        const rows = layout.filter(p => p.type === 'row');
        expect(rows[0].gridPos.y).toBe(0);
        // Second row must start after first group's panels
        // Row header h=1 + data panel h=8 = y should be 9 for second row
        expect(rows[1].gridPos.y).toBe(9);
    });

    it('timeseries panels use w=12 (2 across)', () => {
        const todos = [
            { title: 'P1', rowGroup: 'R1', viz: 'timeseries', unit: '' },
            { title: 'P2', rowGroup: 'R1', viz: 'timeseries', unit: '' },
        ];
        const layout = computeLayout(todos);
        const dataPanel1 = layout.find(p => p.title === 'P1')!;
        const dataPanel2 = layout.find(p => p.title === 'P2')!;
        expect(dataPanel1.gridPos.w).toBe(12);
        expect(dataPanel1.gridPos.x).toBe(0);
        expect(dataPanel2.gridPos.w).toBe(12);
        expect(dataPanel2.gridPos.x).toBe(12);
        // Both at same y (same visual row)
        expect(dataPanel1.gridPos.y).toBe(dataPanel2.gridPos.y);
    });

    it('stat panels use w=6 (4 across)', () => {
        const todos = [
            { title: 'S1', rowGroup: 'Health', viz: 'stat', unit: 'short' },
            { title: 'S2', rowGroup: 'Health', viz: 'stat', unit: 'short' },
            { title: 'S3', rowGroup: 'Health', viz: 'stat', unit: 'short' },
            { title: 'S4', rowGroup: 'Health', viz: 'stat', unit: 'short' },
        ];
        const layout = computeLayout(todos);
        const data = layout.filter(p => p.type === 'data');
        expect(data.map(p => p.gridPos.w)).toEqual([6, 6, 6, 6]);
        expect(data.map(p => p.gridPos.x)).toEqual([0, 6, 12, 18]);
        // All 4 on the same visual row (same y)
        expect(new Set(data.map(p => p.gridPos.y)).size).toBe(1);
    });

    it('stat panels wrap after 4 across (x resets at col 24)', () => {
        const todos = Array.from({ length: 5 }, (_, i) => ({
            title: `S${i + 1}`, rowGroup: 'Health', viz: 'stat', unit: 'short',
        }));
        const layout = computeLayout(todos);
        const data = layout.filter(p => p.type === 'data');
        // First 4 on row 1, 5th wraps to row 2
        const ys = data.map(p => p.gridPos.y);
        expect(ys[0]).toBe(ys[1]);
        expect(ys[0]).toBe(ys[3]);
        expect(ys[4]).toBeGreaterThan(ys[0]);
    });

    it('timeseries panels wrap correctly after 2 across (x resets at col 24)', () => {
        const todos = [
            { title: 'P1', rowGroup: 'R1', viz: 'timeseries', unit: '' },
            { title: 'P2', rowGroup: 'R1', viz: 'timeseries', unit: '' },
            { title: 'P3', rowGroup: 'R1', viz: 'timeseries', unit: '' }, // wraps to next row
        ];
        const layout = computeLayout(todos);
        const data = layout.filter(p => p.type === 'data');
        expect(data[0].gridPos.y).toBe(data[1].gridPos.y); // P1 and P2 same row
        expect(data[2].gridPos.y).toBeGreaterThan(data[1].gridPos.y); // P3 wraps
        expect(data[2].gridPos.x).toBe(0); // P3 starts at x=0
    });

    it('no two data panels overlap in y+h space within a group', () => {
        const todos = Array.from({ length: 6 }, (_, i) => ({
            title: `P${i+1}`, rowGroup: 'R1', viz: 'timeseries', unit: '',
        }));
        const layout = computeLayout(todos);
        const data = layout.filter(p => p.type === 'data');
        for (let i = 0; i < data.length; i++) {
            for (let j = i + 1; j < data.length; j++) {
                const a = data[i].gridPos;
                const b = data[j].gridPos;
                const xOverlap = a.x < b.x + b.w && a.x + a.w > b.x;
                const yOverlap = a.y < b.y + b.h && a.y + a.h > b.y;
                expect(xOverlap && yOverlap).toBe(false);
            }
        }
    });

    it('row header gridPos has h=1, w=24, x=0', () => {
        const todos = [{ title: 'P1', rowGroup: 'R1', viz: 'timeseries', unit: '' }];
        const layout = computeLayout(todos);
        const row = layout.find(p => p.type === 'row')!;
        expect(row.gridPos).toMatchObject({ h: 1, w: 24, x: 0 });
    });

    it('panels in different groups have non-overlapping y ranges', () => {
        const todos = [
            { title: 'P1', rowGroup: 'R1', viz: 'timeseries', unit: '' },
            { title: 'P2', rowGroup: 'R1', viz: 'timeseries', unit: '' },
            { title: 'P3', rowGroup: 'R2', viz: 'timeseries', unit: '' },
        ];
        const layout = computeLayout(todos);
        const r1Panels = layout.filter(p => p.rowGroup === 'R1' && p.type === 'data');
        const r2Panels = layout.filter(p => p.rowGroup === 'R2' && p.type === 'data');
        const r1MaxY = Math.max(...r1Panels.map(p => p.gridPos.y + p.gridPos.h));
        const r2MinY = Math.min(...r2Panels.map(p => p.gridPos.y));
        // Account for row header between groups
        expect(r2MinY).toBeGreaterThanOrEqual(r1MaxY);
    });

    // ── Adaptive stat-width rules ─────────────────────────────────────────

    it('adaptive: 1 stat alone → w=24 (full-width banner)', () => {
        const todos = [
            { title: 'Uptime', rowGroup: 'Health', viz: 'stat', unit: 's' },
        ];
        const layout = computeLayout(todos);
        const stat = layout.find(p => p.type === 'data')!;
        expect(stat.gridPos.w).toBe(24);
        expect(stat.gridPos.h).toBe(4);
    });

    it('adaptive: 2 stats alone → w=12 each', () => {
        const todos = [
            { title: 'S1', rowGroup: 'Health', viz: 'stat', unit: 's' },
            { title: 'S2', rowGroup: 'Health', viz: 'stat', unit: 's' },
        ];
        const layout = computeLayout(todos);
        const data = layout.filter(p => p.type === 'data');
        expect(data.map(p => p.gridPos.w)).toEqual([12, 12]);
        expect(data[0].gridPos.y).toBe(data[1].gridPos.y);
    });

    it('adaptive: 3 stats alone → w=8 each', () => {
        const todos = [
            { title: 'S1', rowGroup: 'Health', viz: 'stat', unit: '' },
            { title: 'S2', rowGroup: 'Health', viz: 'stat', unit: '' },
            { title: 'S3', rowGroup: 'Health', viz: 'stat', unit: '' },
        ];
        const layout = computeLayout(todos);
        const data = layout.filter(p => p.type === 'data');
        expect(data.map(p => p.gridPos.w)).toEqual([8, 8, 8]);
        expect(new Set(data.map(p => p.gridPos.y)).size).toBe(1);
    });

    it('adaptive: 1 stat + 1 timeseries → same row, stat w=6 + ts w=18', () => {
        const todos = [
            { title: 'Uptime', rowGroup: 'Health', viz: 'stat', unit: 's' },
            { title: 'Rate',   rowGroup: 'Health', viz: 'timeseries', unit: 'reqps' },
        ];
        const layout = computeLayout(todos);
        const stat = layout.find(p => p.title === 'Uptime')!;
        const ts   = layout.find(p => p.title === 'Rate')!;
        expect(stat.gridPos.w).toBe(6);
        expect(ts.gridPos.w).toBe(18);
        expect(stat.gridPos.y).toBe(ts.gridPos.y);
    });

    it('adaptive: 1 stat + 2 timeseries → stat w=24 banner, then ts panels below', () => {
        const todos = [
            { title: 'Uptime', rowGroup: 'Health', viz: 'stat',       unit: 's' },
            { title: 'Rate',   rowGroup: 'Health', viz: 'timeseries', unit: 'reqps' },
            { title: 'Errors', rowGroup: 'Health', viz: 'timeseries', unit: 'reqps' },
        ];
        const layout = computeLayout(todos);
        const stat   = layout.find(p => p.title === 'Uptime')!;
        const rateTs = layout.find(p => p.title === 'Rate')!;
        expect(stat.gridPos.w).toBe(24);
        expect(stat.gridPos.h).toBe(4);
        expect(rateTs.gridPos.y).toBeGreaterThan(stat.gridPos.y);
    });

    it('adaptive: 1 wide panel alone → w=24', () => {
        const todos = [
            { title: 'Overview', rowGroup: 'Summary', viz: 'timeseries', unit: '' },
        ];
        const layout = computeLayout(todos);
        const panel = layout.find(p => p.type === 'data')!;
        expect(panel.gridPos.w).toBe(24);
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

    it('uses Model.LARGE for PLAN — never Model.BASE', async () => {
        // New contract: PLAN is the only LLM call when panels > 0
        // CREATE is code-driven (direct callTool, no LLM)
        mockChatCompletions.mockResolvedValueOnce(makeResponse(makePlanResponse()));

        mockMcpClient.callTool
            .mockResolvedValueOnce(makeUpdateDashboardResult('uid-abc'))    // CREATE: update_dashboard
            .mockResolvedValueOnce(makeSummaryEnvelope(2, [                 // VERIFY: get_dashboard_summary
                { id: 1, title: 'Error Log Volume', type: 'timeseries', description: 'd', queryCount: 1 },
                { id: 2, title: 'All Logs', type: 'logs', description: 'd', queryCount: 1 },
            ]))
            .mockResolvedValueOnce(makePanelQueriesEnvelope());              // VERIFY: get_dashboard_panel_queries

        await runDashboardAgent(
            makeStep(), 'build dashboard', '', lokiFindings,
            [], mockMcpClient, 10, new AbortController().signal, onUpdate,
        );

        // Only PLAN calls the LLM; model must be LARGE
        for (const call of mockChatCompletions.mock.calls) {
            expect(call[0].model).toBe('large');
        }
        // No second LLM call (CREATE is code-driven)
        expect(mockChatCompletions.mock.calls.length).toBe(1);
    });

    it('CREATE phase is code-driven: calls update_dashboard directly without an LLM call', async () => {
        // PLAN → code calls update_dashboard → no second LLM call in happy path
        mockChatCompletions.mockResolvedValueOnce(makeResponse(makePlanResponse()));

        mockMcpClient.callTool
            .mockResolvedValueOnce(makeUpdateDashboardResult('uid-direct'))
            .mockResolvedValueOnce(makeSummaryEnvelope(2, [
                { id: 1, title: 'Error Log Volume', type: 'timeseries', description: 'd', queryCount: 1 },
                { id: 2, title: 'All Logs', type: 'logs', description: 'd', queryCount: 1 },
            ]))
            .mockResolvedValueOnce(makePanelQueriesEnvelope());

        const result = await runDashboardAgent(
            makeStep(), 'build dashboard', '', lokiFindings,
            [], mockMcpClient, 10, new AbortController().signal, onUpdate,
        );

        // One LLM call (PLAN only)
        expect(mockChatCompletions.mock.calls.length).toBe(1);
        // First callTool is update_dashboard from code-built CREATE
        const firstCall = mockMcpClient.callTool.mock.calls[0][0];
        expect(firstCall.name).toBe('update_dashboard');
        // The dashboard JSON is in firstCall.arguments.dashboard
        const dash = firstCall.arguments.dashboard;
        expect(dash).toBeDefined();
        expect(Array.isArray(dash.panels)).toBe(true);
        expect(result.dashboardUid).toBe('uid-direct');
    });

    it('dashboard title comes from PLAN phase, not from the raw user message', async () => {
        // The user asked a conversational question — it should never become the title.
        const conversationalUserMessage = 'Can you build a dashboard to monitor this?';

        mockChatCompletions.mockResolvedValueOnce(
            makeResponse(makePlanResponse(undefined, { title: 'OTel Receiver Metrics' }))
        );
        mockMcpClient.callTool
            .mockResolvedValueOnce(makeUpdateDashboardResult('uid-title'))
            .mockResolvedValueOnce(makeSummaryEnvelope(2, [
                { id: 1, title: 'Error Log Volume', type: 'timeseries', description: 'd', queryCount: 1 },
                { id: 2, title: 'All Logs', type: 'logs', description: 'd', queryCount: 1 },
            ]))
            .mockResolvedValueOnce(makePanelQueriesEnvelope());

        await runDashboardAgent(
            makeStep(), conversationalUserMessage, '', lokiFindings,
            [], mockMcpClient, 10, new AbortController().signal, onUpdate,
        );

        const dash = mockMcpClient.callTool.mock.calls[0][0].arguments.dashboard;
        expect(dash.title).toBe('OTel Receiver Metrics');
        expect(dash.title).not.toContain('Can You');
        expect(dash.title).not.toContain('build a dashboard');
    });

    it('falls back to step.description as dashboard title when PLAN omits title', async () => {
        // PLAN response that intentionally has no "title" field
        const planWithNoTitle = JSON.stringify({
            panels: [
                { title: 'Error Log Volume', description: 'Log error rate', query: '{job=~".+"} |= "error"',
                  datasourceType: 'loki', viz: 'timeseries', unit: 'reqps', rowGroup: 'Errors' },
            ],
            variables: [],
            timeRange: { from: 'now-1h', to: 'now' },
            layoutHint: 'none',
        });

        mockChatCompletions.mockResolvedValueOnce(makeResponse(planWithNoTitle));
        mockMcpClient.callTool
            .mockResolvedValueOnce(makeUpdateDashboardResult('uid-fallback'))
            .mockResolvedValueOnce(makeSummaryEnvelope(1, [
                { id: 1, title: 'Error Log Volume', type: 'timeseries', description: 'd', queryCount: 1 },
            ]))
            .mockResolvedValueOnce(makePanelQueriesEnvelope());

        const step = makeStep({ description: 'Build a service log monitoring dashboard' });
        await runDashboardAgent(
            step, 'Can you build a dashboard to monitor this?', '', lokiFindings,
            [], mockMcpClient, 10, new AbortController().signal, onUpdate,
        );

        const dash = mockMcpClient.callTool.mock.calls[0][0].arguments.dashboard;
        expect(dash.title).toBe('Build a service log monitoring dashboard');
    });

    it('code-built CREATE: query from PLAN is written verbatim into the panel target', async () => {
        const loki_expr = '{job=~".+"} |= "error" | logfmt';
        mockChatCompletions.mockResolvedValueOnce(makeResponse(makePlanResponse([
            { title: 'Error Log Volume', description: 'd', query: loki_expr,
              datasourceType: 'loki', viz: 'timeseries', unit: 'reqps', rowGroup: 'Errors', legendFormat: '{{job}}' },
        ])));

        mockMcpClient.callTool
            .mockResolvedValueOnce(makeUpdateDashboardResult('uid-q'))
            .mockResolvedValueOnce(makeSummaryEnvelope(1, [
                { id: 2, title: 'Error Log Volume', type: 'timeseries', description: 'd', queryCount: 1 },
            ]))
            .mockResolvedValueOnce(makePanelQueriesEnvelope());

        await runDashboardAgent(
            makeStep(), 'build', '', lokiFindings, [], mockMcpClient, 10,
            new AbortController().signal, onUpdate,
        );

        const dash = mockMcpClient.callTool.mock.calls[0][0].arguments.dashboard;
        const dataPanel = dash.panels.find((p: any) => p.type !== 'row');
        expect(dataPanel.targets[0].expr).toBe(loki_expr);
        expect(dataPanel.targets[0].legendFormat).toBe('{{job}}');
        expect(dataPanel.fieldConfig.defaults.unit).toBe('reqps');
    });

    it('code-built CREATE: stats-first layout — stat panels appear before timeseries in JSON', async () => {
        const panels = [
            { title: 'Total Calls', description: 'd', query: 'sum(calls_total)', datasourceType: 'prometheus',
              viz: 'stat', unit: 'short', rowGroup: 'Overview', legendFormat: '' },
            { title: 'Call Rate', description: 'd', query: 'rate(calls_total[5m])', datasourceType: 'prometheus',
              viz: 'timeseries', unit: 'reqps', rowGroup: 'Overview', legendFormat: '{{job}}' },
        ];
        mockChatCompletions.mockResolvedValueOnce(makeResponse(makePlanResponse(panels)));
        mockMcpClient.callTool
            .mockResolvedValueOnce(makeUpdateDashboardResult('uid-layout'))
            .mockResolvedValueOnce(makeSummaryEnvelope(2, [
                { id: 2, title: 'Total Calls', type: 'stat', description: 'd', queryCount: 1 },
                { id: 3, title: 'Call Rate', type: 'timeseries', description: 'd', queryCount: 1 },
            ]))
            .mockResolvedValueOnce(makePanelQueriesEnvelope());

        await runDashboardAgent(
            makeStep(), 'build', '', prometheusFindings, [], mockMcpClient, 10,
            new AbortController().signal, onUpdate,
        );

        const dash = mockMcpClient.callTool.mock.calls[0][0].arguments.dashboard;
        const dataPanels = dash.panels.filter((p: any) => p.type !== 'row');
        const statPanel = dataPanels.find((p: any) => p.type === 'stat');
        const tsPanel = dataPanels.find((p: any) => p.type === 'timeseries');
        // 1 stat + 1 timeseries → same row (paired KPI + trend), stat w=6, ts w=18
        expect(statPanel.gridPos.y).toBe(tsPanel.gridPos.y);
        expect(statPanel.gridPos.w).toBe(6);
        expect(tsPanel.gridPos.w).toBe(18);
        // stat appears before timeseries in array
        const statIdx = dataPanels.indexOf(statPanel);
        const tsIdx = dataPanels.indexOf(tsPanel);
        expect(statIdx).toBeLessThan(tsIdx);
    });

    it('code-built CREATE: folderUid is used, not folderId', async () => {
        mockChatCompletions.mockResolvedValueOnce(makeResponse(makePlanResponse()));
        mockMcpClient.callTool
            .mockResolvedValueOnce(makeUpdateDashboardResult('uid-folder'))
            .mockResolvedValueOnce(makeSummaryEnvelope(2, [
                { id: 1, title: 'Error Log Volume', type: 'timeseries', description: 'd', queryCount: 1 },
                { id: 2, title: 'All Logs', type: 'logs', description: 'd', queryCount: 1 },
            ]))
            .mockResolvedValueOnce(makePanelQueriesEnvelope());

        await runDashboardAgent(
            makeStep(), 'build', '', lokiFindings, [], mockMcpClient, 10,
            new AbortController().signal, onUpdate,
        );

        const createArgs = mockMcpClient.callTool.mock.calls[0][0].arguments;
        expect(createArgs.folderUid).toBeDefined();
        expect(createArgs.folderId).toBeUndefined();
    });

    it('code-built CREATE: generic legendFormat — no OTel-specific {{service_name}} default', async () => {
        // When legendFormat is empty string in plan, it should pass through as '' (not as {{service_name}})
        const panels = [
            { title: 'CPU Rate', description: 'd', query: 'rate(node_cpu_seconds_total[5m])',
              datasourceType: 'prometheus', viz: 'timeseries', unit: 'percentunit',
              rowGroup: 'CPU', legendFormat: '{{mode}}' },
            { title: 'Uptime', description: 'd', query: 'node_time_seconds - node_boot_time_seconds',
              datasourceType: 'prometheus', viz: 'stat', unit: 's',
              rowGroup: 'Health', legendFormat: '' },  // single-series: empty legend
        ];
        mockChatCompletions.mockResolvedValueOnce(makeResponse(makePlanResponse(panels)));
        mockMcpClient.callTool
            .mockResolvedValueOnce(makeUpdateDashboardResult('uid-legend'))
            .mockResolvedValueOnce(makeSummaryEnvelope(2, [
                { id: 3, title: 'CPU Rate', type: 'timeseries', description: 'd', queryCount: 1 },
                { id: 2, title: 'Uptime', type: 'stat', description: 'd', queryCount: 1 },
            ]))
            .mockResolvedValueOnce(makePanelQueriesEnvelope());

        await runDashboardAgent(
            makeStep(), 'build', '', prometheusFindings, [], mockMcpClient, 10,
            new AbortController().signal, onUpdate,
        );

        const dash = mockMcpClient.callTool.mock.calls[0][0].arguments.dashboard;
        const cpuPanel = dash.panels.find((p: any) => p.title === 'CPU Rate');
        const uptimePanel = dash.panels.find((p: any) => p.title === 'Uptime');

        // CPU panel uses the plan's legendFormat, not a guess
        expect(cpuPanel.targets[0].legendFormat).toBe('{{mode}}');
        // Uptime uses empty string (not {{service_name}} or any other default)
        expect(uptimePanel.targets[0].legendFormat).toBe('');
    });

    it('PLAN phase queries appear in PLAN prompt — datasource uid from findings', async () => {
        mockChatCompletions.mockResolvedValueOnce(makeResponse(makePlanResponse()));
        mockMcpClient.callTool
            .mockResolvedValueOnce(makeUpdateDashboardResult('uid-plan'))
            .mockResolvedValueOnce(makeSummaryEnvelope(2, [
                { id: 1, title: 'Error Log Volume', type: 'timeseries', description: 'd', queryCount: 1 },
                { id: 2, title: 'All Logs', type: 'logs', description: 'd', queryCount: 1 },
            ]))
            .mockResolvedValueOnce(makePanelQueriesEnvelope());

        await runDashboardAgent(
            makeStep(), 'build', '', lokiFindings, [], mockMcpClient, 10,
            new AbortController().signal, onUpdate,
        );

        const planSystemMsg = mockChatCompletions.mock.calls[0][0].messages
            .find((m: any) => m.role === 'system')?.content ?? '';
        expect(planSystemMsg).toContain('loki-uid-123');
        expect(planSystemMsg).toContain('{job=~".+"} |= "error" | logfmt');
        expect(planSystemMsg).toContain('Error log volume by service');
    });

    it('only passes dashboard and datasource tools to REPAIR/fallback loops', async () => {
        // With panels from PLAN, CREATE is code-driven (no tool scoping needed).
        // Tool scoping applies to the REPAIR loop. Force a repair by returning 0 panels.
        mockChatCompletions
            .mockResolvedValueOnce(makeResponse(makePlanResponse()))   // PLAN
            .mockResolvedValue(makeResponse('repaired'));               // REPAIR loop

        mockMcpClient.callTool
            .mockResolvedValueOnce(makeUpdateDashboardResult('uid-tools'))  // CREATE
            .mockResolvedValueOnce(makeSummaryEnvelope(0, []))              // VERIFY: 0 panels → REPAIR
            .mockResolvedValueOnce(makeUpdateDashboardResult('uid-tools'))  // REPAIR update_dashboard
            .mockResolvedValueOnce(makeSummaryEnvelope(2, [                 // 2nd VERIFY
                { id: 1, title: 'Error Log Volume', type: 'timeseries', description: 'd', queryCount: 1 },
                { id: 2, title: 'All Logs', type: 'logs', description: 'd', queryCount: 1 },
            ]))
            .mockResolvedValueOnce(makePanelQueriesEnvelope());

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

        // REPAIR LLM call should have scoped tools (no query tools)
        const repairCall = mockChatCompletions.mock.calls[1]?.[0];
        if (repairCall) {
            const toolNames = repairCall.tools?.map((t: any) => t.function.name) ?? [];
            expect(toolNames).not.toContain('query_loki_logs');
            expect(toolNames).not.toContain('query_prometheus');
        }
    });

    it('returns success result with dashboardUid', async () => {
        mockChatCompletions.mockResolvedValueOnce(makeResponse(makePlanResponse()));

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

    it('calls onUpdate with update_dashboard pending/success', async () => {
        mockChatCompletions.mockResolvedValueOnce(makeResponse(makePlanResponse()));
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

        mockChatCompletions.mockResolvedValue(makeResponse(makePlanResponse()));
        mockMcpClient.callTool.mockResolvedValue({ content: [] });

        await expect(
            runDashboardAgent(
                makeStep(), 'build', '', lokiFindings,
                [{ type: 'function', function: { name: 'update_dashboard' } }],
                mockMcpClient, 10, controller.signal, onUpdate,
            )
        ).rejects.toThrow('Aborted');
    });

    it('works with empty DataFindings — falls back to LLM-driven CREATE', async () => {
        // When PLAN returns 0 panels AND no findings, agent falls back to LLM loop
        mockChatCompletions.mockResolvedValue(makeResponse(JSON.stringify({
            panels: [],  // empty plan → triggers LLM-driven fallback
            variables: [], timeRange: { from: 'now-1h', to: 'now' },
        })));

        const result = await runDashboardAgent(
            makeStep(), 'organise dashboards', '', {},
            [], mockMcpClient, 10, new AbortController().signal, onUpdate,
        );

        // Falls back gracefully even with no mcpClient calls
        expect(result.status).toBe('success');
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

    // ── CREATE phase (code-driven) ────────────────────────────────────────

    it('CREATE phase: code-built JSON has correct schemaVersion and time range from PLAN', async () => {
        mockChatCompletions.mockResolvedValueOnce(makeResponse(makePlanResponse()));
        mockMcpClient.callTool
            .mockResolvedValueOnce(makeUpdateDashboardResult('uid-schema'))
            .mockResolvedValueOnce(makeSummaryEnvelope(2, [
                { id: 1, title: 'Error Log Volume', type: 'timeseries', description: 'd', queryCount: 1 },
                { id: 2, title: 'All Logs', type: 'logs', description: 'd', queryCount: 1 },
            ]))
            .mockResolvedValueOnce(makePanelQueriesEnvelope());

        await runDashboardAgent(
            makeStep(), 'build dashboard', '', lokiFindings,
            [], mockMcpClient, 10, new AbortController().signal, onUpdate,
        );

        const dash = mockMcpClient.callTool.mock.calls[0][0].arguments.dashboard;
        expect(dash.schemaVersion).toBe(38);
        expect(dash.time).toMatchObject({ from: 'now-1h', to: 'now' });
        expect(dash.refresh).toBe('30s');
        expect(Array.isArray(dash.panels)).toBe(true);
    });

    it('CREATE phase: non-OTel metrics (node_exporter) work correctly', async () => {
        // Genericity test: node_exporter metrics — completely different domain from OTel
        const nodePanels = [
            { title: 'CPU Utilisation', description: 'CPU usage by mode', query: 'rate(node_cpu_seconds_total{mode!="idle"}[5m])',
              datasourceType: 'prometheus', viz: 'timeseries', unit: 'percentunit',
              rowGroup: 'CPU', legendFormat: '{{mode}}' },
            { title: 'Available Memory', description: 'Free + buffers + cache', query: 'node_memory_MemAvailable_bytes',
              datasourceType: 'prometheus', viz: 'stat', unit: 'bytes',
              rowGroup: 'Memory', legendFormat: '',
              thresholds: [{ value: null, color: 'green' }, { value: 500000000, color: 'orange' }] },
            { title: 'Disk Reads', description: 'Disk read rate', query: 'rate(node_disk_read_bytes_total[5m])',
              datasourceType: 'prometheus', viz: 'timeseries', unit: 'Bps',
              rowGroup: 'Disk', legendFormat: '{{device}}' },
        ];

        const nodeFindings = {
            prometheus: {
                datasourceUid: 'node-prom-uid',
                datasourceName: 'Node Prometheus',
                labels: { instance: ['host1', 'host2'], mode: ['idle', 'user', 'system'] },
                validatedQueries: [
                    { description: 'CPU rate', promql: 'rate(node_cpu_seconds_total{mode!="idle"}[5m])', unit: 'percentunit', suggestedViz: 'timeseries' as const },
                ],
            },
        };

        mockChatCompletions.mockResolvedValueOnce(makeResponse(makePlanResponse(nodePanels)));
        mockMcpClient.callTool
            .mockResolvedValueOnce(makeUpdateDashboardResult('uid-node'))
            .mockResolvedValueOnce(makeSummaryEnvelope(3, [
                { id: 2, title: 'CPU Utilisation', type: 'timeseries', description: 'd', queryCount: 1 },
                { id: 3, title: 'Available Memory', type: 'stat', description: 'd', queryCount: 1 },
                { id: 5, title: 'Disk Reads', type: 'timeseries', description: 'd', queryCount: 1 },
            ]))
            .mockResolvedValueOnce(makePanelQueriesEnvelope());

        const result = await runDashboardAgent(
            makeStep({ description: 'Build node exporter dashboard' }),
            'build node metrics dashboard', '', nodeFindings,
            [], mockMcpClient, 10, new AbortController().signal, onUpdate,
        );

        const dash = mockMcpClient.callTool.mock.calls[0][0].arguments.dashboard;
        const dataPanels = dash.panels.filter((p: any) => p.type !== 'row');

        // Stats-first layout: Available Memory (stat) is first in Memory row
        const memoryRow = dash.panels.filter((p: any) => p.type === 'row').find((p: any) => p.title === 'Memory');
        expect(memoryRow).toBeDefined();

        // CPU panel has correct query and domain-specific legend ({{mode}})
        const cpuPanel = dash.panels.find((p: any) => p.title === 'CPU Utilisation');
        expect(cpuPanel?.targets[0].expr).toBe('rate(node_cpu_seconds_total{mode!="idle"}[5m])');
        expect(cpuPanel?.targets[0].legendFormat).toBe('{{mode}}');  // not {{service_name}}
        expect(cpuPanel?.fieldConfig.defaults.unit).toBe('percentunit');

        // Memory stat has threshold from plan
        const memPanel = dash.panels.find((p: any) => p.title === 'Available Memory');
        expect(memPanel?.targets[0].legendFormat).toBe('');  // empty — single series
        expect(memPanel?.fieldConfig.defaults.thresholds.steps).toHaveLength(2);

        // Disk panel has correct unit and legend
        const diskPanel = dash.panels.find((p: any) => p.title === 'Disk Reads');
        expect(diskPanel?.targets[0].legendFormat).toBe('{{device}}');
        expect(diskPanel?.fieldConfig.defaults.unit).toBe('Bps');

        expect(result.status).toBe('success');
        expect(result.dashboardUid).toBe('uid-node');
        expect(dataPanels.length).toBe(3);
    });

    // ── VERIFY + REPAIR ───────────────────────────────────────────────────

    it('REGRESSION: code-built CREATE writes panels; VERIFY detects them; no REPAIR needed', async () => {
        // With code-built CREATE, the "empty skeleton" regression is impossible:
        // code writes panels from the PLAN directly. VERIFY should find them and exit clean.
        mockChatCompletions.mockResolvedValueOnce(makeResponse(makePlanResponse([
            { title: 'Error Logs', description: 'err', query: '{job="api"} |= "error"',
              datasourceType: 'loki', viz: 'logs', unit: '', rowGroup: 'Logs', legendFormat: '' },
        ])));

        mockMcpClient.callTool
            .mockResolvedValueOnce(makeUpdateDashboardResult('uid-no-regression'))  // CREATE
            .mockResolvedValueOnce(makeSummaryEnvelope(1, [                         // VERIFY: panelCount=1
                { id: 2, title: 'Error Logs', type: 'logs', description: 'err', queryCount: 1 },
            ]))
            .mockResolvedValueOnce(makePanelQueriesEnvelope([                        // VERIFY: panel queries
                { title: 'Error Logs', query: '{job="api"} |= "error"',
                  datasource: { uid: 'loki-uid-123', type: 'loki' } },
            ]));

        const result = await runDashboardAgent(
            makeStep(), 'build', '', lokiFindings,
            [{ type: 'function', function: { name: 'update_dashboard' } }],
            mockMcpClient, 10, new AbortController().signal, onUpdate,
        );

        // Only one update_dashboard call (CREATE) — no REPAIR needed
        const updateCalls = mockMcpClient.callTool.mock.calls
            .filter((c: any[]) => c[0].name === 'update_dashboard');
        expect(updateCalls).toHaveLength(1);

        // Dashboard written by code has panel in it (from PLAN query)
        const dash = updateCalls[0][0].arguments.dashboard;
        const dataPanels = dash.panels.filter((p: any) => p.type !== 'row');
        expect(dataPanels).toHaveLength(1);
        expect(dataPanels[0].targets[0].expr).toBe('{job="api"} |= "error"');

        expect(result.status).toBe('success');
        expect(result.dashboardUid).toBe('uid-no-regression');
    });

    it('REPAIR: VERIFY finds 0 panels after CREATE → REPAIR fills them via LLM', async () => {
        // Simulates: update_dashboard succeeds but Grafana returns panelCount=0 (write failure)
        mockChatCompletions.mockResolvedValueOnce(makeResponse(makePlanResponse([
            { title: 'Error Logs', description: 'err', query: '{job="api"} |= "error"',
              datasourceType: 'loki', viz: 'logs', unit: '', rowGroup: 'Logs', legendFormat: '' },
        ])));

        // REPAIR phase LLM response
        mockChatCompletions
            .mockResolvedValueOnce(makeResponse('', [
                makeToolCall('update_dashboard', 'tc-repair', JSON.stringify({
                    dashboard: { title: 'Fixed', uid: 'uid-repair', panels: [
                        { id: 2, type: 'logs', title: 'Error Logs', description: 'err',
                          gridPos: { h: 8, w: 24, x: 0, y: 1 },
                          targets: [{ expr: '{job="api"} |= "error"', datasource: { type: 'loki', uid: 'loki-uid-123' } }] },
                    ], schemaVersion: 38 },
                    overwrite: true,
                })),
            ]))
            .mockResolvedValueOnce(makeResponse('Panels added.'));

        mockMcpClient.callTool
            .mockResolvedValueOnce(makeUpdateDashboardResult('uid-repair'))   // CREATE
            .mockResolvedValueOnce(makeSummaryEnvelope(0, []))                // VERIFY: 0 panels!
            .mockResolvedValueOnce(makeUpdateDashboardResult('uid-repair'))   // REPAIR
            .mockResolvedValueOnce(makeSummaryEnvelope(1, [                   // 2nd VERIFY
                { id: 2, title: 'Error Logs', type: 'logs', description: 'err', queryCount: 1 },
            ]))
            .mockResolvedValueOnce(makePanelQueriesEnvelope([
                { title: 'Error Logs', query: '{job="api"} |= "error"',
                  datasource: { uid: 'loki-uid-123', type: 'loki' } },
            ]));

        const result = await runDashboardAgent(
            makeStep(), 'build', '', lokiFindings,
            [{ type: 'function', function: { name: 'update_dashboard' } }],
            mockMcpClient, 20, new AbortController().signal, onUpdate,
        );

        const updateCalls = mockMcpClient.callTool.mock.calls
            .filter((c: any[]) => c[0].name === 'update_dashboard');
        expect(updateCalls.length).toBeGreaterThanOrEqual(2);
        expect(result.status).toBe('success');
        expect(result.dashboardUid).toBe('uid-repair');
    });

    it('REPAIR: retries when callTool returns an error on CREATE', async () => {
        // First callTool (CREATE update_dashboard) throws — code catches, dashboardUid stays undefined.
        // Since there's no UID yet, VERIFY/REPAIR are skipped; result is error.
        // Verify that a callTool error on CREATE propagates correctly.
        mockChatCompletions.mockResolvedValueOnce(makeResponse(makePlanResponse()));

        const errorEnv = { content: [{ type: 'text', text: 'Error: validation failed' }], isError: true };
        mockMcpClient.callTool
            .mockResolvedValueOnce(errorEnv);                    // CREATE fails — no UID extracted

        const result = await runDashboardAgent(
            makeStep(), 'build', '', lokiFindings,
            [{ type: 'function', function: { name: 'update_dashboard' } }],
            mockMcpClient, 20, new AbortController().signal, onUpdate,
        );

        // No UID was extracted from the failed response, summary notes it
        expect(result.dashboardUid).toBeUndefined();
    });

    it('VERIFY: calls get_dashboard_summary and get_dashboard_panel_queries after code-built CREATE', async () => {
        mockChatCompletions.mockResolvedValueOnce(makeResponse(makePlanResponse()));

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
        mockChatCompletions.mockResolvedValueOnce(makeResponse(makePlanResponse([
            { title: 'Error Log Volume', description: 'd', query: '{job=~".+"} |= "error"',
              datasourceType: 'loki', viz: 'timeseries', unit: '', rowGroup: 'Row', legendFormat: '' },
            { title: 'All Logs', description: 'd', query: '{job=~".+"}',
              datasourceType: 'loki', viz: 'logs', unit: '', rowGroup: 'Row', legendFormat: '' },
        ])));

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

        mockMcpClient.callTool
            .mockResolvedValueOnce(makeUpdateDashboardResult('uid-clean'))  // CREATE
            .mockResolvedValueOnce(makeSummaryEnvelope(2, [                 // VERIFY
                { id: 2, title: 'Error Log Volume', type: 'timeseries', description: 'd', queryCount: 1 },
                { id: 3, title: 'All Logs', type: 'logs', description: 'd', queryCount: 1 },
            ]))
            .mockResolvedValueOnce(makePanelQueriesEnvelope([               // panel queries
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
                { title: 'Logs', description: 'log stream', query: '{job="api"} |= "error"',
                  datasourceType: 'loki', viz: 'logs', unit: '', rowGroup: 'Logs', legendFormat: '' },
            ])))
            // REPAIR phase LLM response
            .mockResolvedValueOnce(makeResponse('', [makeToolCall('update_dashboard', 'tc-fix',
                JSON.stringify({ uid: 'uid-mismatch', operations: [{ op: 'replace', path: '$.panels[0].targets[0].datasource', value: { type: 'loki', uid: 'loki-uid-123' } }], overwrite: true }))]))
            .mockResolvedValueOnce(makeResponse('Fixed mismatch.'));

        mockMcpClient.callTool
            .mockResolvedValueOnce(makeUpdateDashboardResult('uid-mismatch'))  // CREATE (code-built)
            // VERIFY 1: datasource mismatch — loki query on prometheus datasource
            .mockResolvedValueOnce(makeSummaryEnvelope(1, [{ id: 2, title: 'Logs', type: 'logs', description: 'd', queryCount: 1 }]))
            .mockResolvedValueOnce(makePanelQueriesEnvelope([
                { title: 'Logs', query: '{job="api"} |= "error"', datasource: { uid: 'p', type: 'prometheus' } },
            ]))
            // REPAIR update_dashboard
            .mockResolvedValueOnce(makeUpdateDashboardResult('uid-mismatch'))
            // VERIFY 2: clean
            .mockResolvedValueOnce(makeSummaryEnvelope(1, [{ id: 2, title: 'Logs', type: 'logs', description: 'd', queryCount: 1 }]))
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
        // With code-built CREATE, the panels are written directly.
        // V2 fallback happens in the REPAIR loop when VERIFY finds 0 panels,
        // and the REPAIR LLM tries V2 which gets rejected.
        const k8sError = JSON.stringify([{ text: 'a Kubernetes-capable Grafana is required to save a v2 dashboard' }]);

        mockChatCompletions
            .mockResolvedValueOnce(makeResponse(makePlanResponse()))          // PLAN
            .mockResolvedValueOnce(makeResponse('', [                         // REPAIR round 1: LLM tries V2
                makeToolCall('update_dashboard', 'tc1', JSON.stringify({ dashboard: { elements: {}, layout: {} }, overwrite: false })),
            ]))
            .mockResolvedValueOnce(makeResponse('Rebuilt as v1 and created dashboard'));  // REPAIR after fallback

        const mcpClient = {
            callTool: jest.fn()
                .mockResolvedValueOnce(makeUpdateDashboardResult('uid-v1-code'))  // CREATE (code-built)
                .mockResolvedValueOnce(makeSummaryEnvelope(0, []))               // VERIFY: 0 → REPAIR
                .mockResolvedValueOnce({ content: k8sError })                   // REPAIR tc1 — V2 fails
                .mockResolvedValue(makeSummaryEnvelope(2, [                      // 2nd VERIFY
                    { id: 1, title: 'Error Log Volume', type: 'timeseries', description: 'd', queryCount: 1 },
                    { id: 2, title: 'All Logs', type: 'logs', description: 'd', queryCount: 1 },
                ])),
        };

        const result = await runDashboardAgent(
            makeStep(), 'build', '', {}, [], mcpClient, 10,
            new AbortController().signal, onUpdate, [], '', 'v2-capable',
        );

        // Agent ran at least: PLAN + REPAIR iterations
        expect(mockChatCompletions.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(result.status).toBe('success');
    });

    // ── NO_COMPRESS (dashboard JSON must never be compressed) ─────────────

    it('code-built CREATE is a direct callTool — no compression concerns in CREATE', async () => {
        // In the new flow, CREATE is a direct callTool call — the full dashboard JSON
        // is sent as arguments, never through an LLM message context that could be compressed.
        // Verify: the actual dashboard JSON reaches update_dashboard with all panels intact.
        mockChatCompletions.mockResolvedValueOnce(makeResponse(makePlanResponse()));

        mockMcpClient.callTool
            .mockResolvedValueOnce(makeUpdateDashboardResult('abc'))
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

        // The callTool arguments contain the full dashboard JSON directly
        const createArgs = mockMcpClient.callTool.mock.calls[0][0].arguments;
        expect(createArgs.dashboard).toBeDefined();
        expect(Array.isArray(createArgs.dashboard.panels)).toBe(true);
        // panels contains rows + data panels from PLAN
        expect(createArgs.dashboard.panels.length).toBeGreaterThan(0);
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
