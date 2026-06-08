import { validateDashboardLayout } from './dashboardLayoutValidate';
import { planProgrammaticFallback } from './programmaticLlmFallback';

describe('dashboardLayoutValidate', () => {
    it('detects overlapping panels on same row', () => {
        const panels = [
            { id: 200, type: 'barchart', title: 'Pressure', gridPos: { x: 0, y: 2, w: 12, h: 8 } },
            { id: 201, type: 'timeseries', title: 'Pressure Trends', gridPos: { x: 12, y: 2, w: 12, h: 8 } },
        ];
        const issues = validateDashboardLayout(panels as Record<string, unknown>[]);
        expect(issues.some((i) => i.code === 'grid_overlap')).toBe(true);
    });
});

describe('planProgrammaticFallback', () => {
    it('plans rebuild when LLM asks questions despite uid', () => {
        const plan = planProgrammaticFallback({
            userMessage: 'Rebuild the dashboard of UID = cfo0wckufbdhce from scratch using best practices.',
            assistantContent: 'What metrics should this dashboard display?',
            toolExecutions: [],
        });
        expect(plan?.kind).toBe('dashboard_rebuild');
    });

    it('plans title row when LLM emits leaked tool calls without saving', () => {
        const plan = planProgrammaticFallback({
            userMessage: 'Add a title row of "Keysight" at the top of the Grafana dashboard with UID = cfo0wckufbdhce',
            assistantContent: 'fetching\n<function_calls>\n<invoke name="get_dashboard_by_uid">',
            toolExecutions: [],
        });
        expect(plan?.kind).toBe('dashboard_title_row');
    });
});
