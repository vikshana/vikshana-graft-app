import {
    enrichDashboardToolResult,
    formatDashboardSummaryReference,
    formatSearchDashboardReference,
    getDashboardUserReference,
    summarizeDashboardTool,
} from './dashboardReference';

describe('dashboardReference', () => {
    it('formats search results with uid table', () => {
        const extra = formatSearchDashboardReference({
            dashboards: [{ uid: 'abc123', title: 'Plant Overview', folderTitle: 'Ops' }],
        });
        expect(extra).toContain('abc123');
        expect(extra).toContain('Plant Overview');
        expect(extra).toContain('get_dashboard_summary');
    });

    it('formats panel index from summary', () => {
        const extra = formatDashboardSummaryReference({
            uid: 'xyz',
            title: 'Metrics',
            panels: [
                { id: 10, title: 'CPU', type: 'timeseries' },
                { id: 11, title: 'Memory', type: 'gauge' },
            ],
        });
        expect(extra).toContain('arrayIndex');
        expect(extra).toContain('panelId');
        expect(extra).toContain('**0**');
        expect(extra).toContain('| 10 |');
        expect(extra).toContain('$.panels[0]');
    });

    it('enriches search_dashboards JSON', () => {
        const raw = JSON.stringify({
            dashboards: [{ uid: 'u1', title: 'Dash' }],
            total: 1,
        });
        const out = enrichDashboardToolResult('search_dashboards', raw);
        expect(out).toContain('u1');
        expect(out.length).toBeGreaterThan(raw.length);
    });

    it('extracts user reference for UI from summary JSON', () => {
        const ref = getDashboardUserReference(
            'get_dashboard_summary',
            JSON.stringify({
                uid: 'xyz',
                panels: [{ id: 5, title: 'CPU', type: 'timeseries' }],
            })
        );
        expect(ref).toContain('panelId');
        expect(ref).toContain('| 5 |');
    });

    it('summarizes search for tool UI', () => {
        const s = summarizeDashboardTool(
            'search_dashboards',
            JSON.stringify({ dashboards: [{ uid: 'a' }, { uid: 'b' }] })
        );
        expect(s).toContain('Found 2');
        expect(s).toContain('a');
    });
});
