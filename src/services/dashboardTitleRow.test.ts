import {
    applyDashboardTitleRow,
    buildDashboardTitleTextPanel,
    isDashboardTitleRowLayoutApplied,
    shiftPanelGridPos,
    titleRowMarkdown,
} from './dashboardTitleRowLayout';
import {
    formatDashboardTitleRowExamplePrompt,
    parseDashboardTitleRowRequest,
    userWantsDashboardTitleRow,
} from './dashboardTitleRowParse';

describe('dashboardTitleRowParse', () => {
    it('parses Keysight title row prompt', () => {
        const req = parseDashboardTitleRowRequest(
            'Add a title row of "Keysight" at the top of the Grafana dashboard with UID = cfo0wckufbdhce'
        );
        expect(req).toEqual({
            dashboardUid: 'cfo0wckufbdhce',
            dashboardTitle: undefined,
            titleLabel: 'Keysight',
        });
    });

    it('detects user intent', () => {
        expect(
            userWantsDashboardTitleRow(
                'Add a title row of "Keysight" at the top of the Grafana dashboard with UID = cfo0wckufbdhce'
            )
        ).toBe(true);
    });

    it('parses change title prompt', () => {
        const req = parseDashboardTitleRowRequest(
            'Change the title to "ElectraMet Keysight" at the top of the Grafana dashboard with UID = cfo0wckufbdhce'
        );
        expect(req).toEqual({
            dashboardUid: 'cfo0wckufbdhce',
            dashboardTitle: undefined,
            titleLabel: 'ElectraMet Keysight',
        });
    });

    it('updates existing title panel label without shifting again', () => {
        const panels = [
            {
                id: 999,
                type: 'text',
                title: '',
                options: { mode: 'markdown', content: '# Keysight' },
                gridPos: { x: 0, y: 0, w: 24, h: 2 },
            },
            { id: 200, type: 'barchart', title: 'Pressure', gridPos: { x: 0, y: 2, w: 12, h: 8 } },
        ];
        const applied = applyDashboardTitleRow(panels as Record<string, unknown>[], 'ElectraMet Keysight');
        expect((applied.titlePanel.options as { content: string }).content).toBe('# ElectraMet Keysight');
        expect(applied.shiftedPanels).toBe(0);
    });

    it('formats example prompt', () => {
        expect(formatDashboardTitleRowExamplePrompt()).toContain('cfo0wckufbdhce');
    });

    it('rejects panel rename prompts', () => {
        const panelRename =
            'Rename the "Pressure Gauge" panel to "System Pressure" on dashboard UID = cfo0wckufbdhce.';
        expect(userWantsDashboardTitleRow(panelRename)).toBe(false);
        expect(parseDashboardTitleRowRequest(panelRename)).toBeNull();
    });
});

describe('dashboardTitleRowLayout', () => {
    it('builds markdown heading content', () => {
        expect(titleRowMarkdown('Keysight')).toBe('# Keysight');
    });

    it('places title first and shifts overlapping row-0 panels down', () => {
        const panels = [
            { id: 200, type: 'barchart', title: 'Pressure', gridPos: { x: 0, y: 0, w: 12, h: 8 } },
            { id: 20, type: 'gauge', title: 'Temperature', gridPos: { x: 12, y: 0, w: 12, h: 8 } },
            { id: 4, type: 'timeseries', title: 'Overview', gridPos: { x: 0, y: 8, w: 24, h: 14 } },
            {
                id: 999,
                type: 'text',
                title: '',
                options: { mode: 'markdown', content: '# Keysight' },
                gridPos: { x: 0, y: 0, w: 24, h: 2 },
            },
        ];

        const applied = applyDashboardTitleRow(panels as Record<string, unknown>[], 'Keysight');
        expect(applied.panels[0].id).toBe(999);
        expect(applied.shiftedPanels).toBe(3);
        expect((applied.panels[1] as { gridPos: { y: number } }).gridPos.y).toBe(2);
        expect((applied.panels[2] as { gridPos: { y: number } }).gridPos.y).toBe(2);
        expect((applied.panels[3] as { gridPos: { y: number } }).gridPos.y).toBe(10);
        expect(isDashboardTitleRowLayoutApplied(applied.panels as Record<string, unknown>[], applied.titlePanel)).toBe(
            true
        );
    });

    it('shifts nested row panels', () => {
        const row = {
            id: 16,
            type: 'row',
            title: 'Stats',
            gridPos: { x: 0, y: 22, w: 24, h: 1 },
            panels: [{ id: 17, type: 'gauge', gridPos: { x: 0, y: 23, w: 6, h: 4 } }],
        };
        shiftPanelGridPos(row as Record<string, unknown>, 2);
        expect((row.gridPos as { y: number }).y).toBe(24);
        expect(((row.panels as { gridPos: { y: number } }[])[0].gridPos as { y: number }).y).toBe(25);
    });

    it('creates a new title panel when none exists', () => {
        const applied = applyDashboardTitleRow([], 'Acme');
        expect(applied.created).toBe(true);
        expect(applied.titlePanel).toEqual(buildDashboardTitleTextPanel('Acme', 1));
    });
});
