import {
    applyBestPracticeDashboardLayout,
} from './dashboardLayoutBestPractices';
import {
    formatDashboardRebuildExamplePrompt,
    parseDashboardRebuildRequest,
    userWantsDashboardRebuild,
} from './dashboardRebuildParse';
import { panelLooksLikeDashboardTitleRow } from './dashboardTitleRowLayout';
import { parseLeakedToolCalls } from './leakedToolCallRecovery';

describe('dashboardRebuildParse', () => {
    it('parses rebuild from scratch prompt', () => {
        const req = parseDashboardRebuildRequest(
            'Rebuild the dashboard of UID = cfo0wckufbdhce from scratch using best practices.'
        );
        expect(req).toEqual({
            dashboardUid: 'cfo0wckufbdhce',
            dashboardTitle: undefined,
            titleLabel: undefined,
        });
    });

    it('parses PowerTech Keysight follow-up', () => {
        const req = parseDashboardRebuildRequest(
            'Add and remove panels based on PowerTech conventions that monitors the Keysight machine.'
        );
        expect(req?.titleLabel).toBe('Keysight');
        expect(userWantsDashboardRebuild(
            'Add and remove panels based on PowerTech conventions that monitors the Keysight machine.'
        )).toBe(true);
    });
});

describe('dashboardLayoutBestPractices', () => {
    it('fixes Keysight overlap and keeps title first', () => {
        const panels = [
            {
                id: 999,
                type: 'text',
                title: '',
                options: { mode: 'markdown', content: '# Keysight' },
                gridPos: { x: 0, y: 0, w: 24, h: 2 },
            },
            { id: 200, type: 'barchart', title: 'Pressure', gridPos: { x: 0, y: 2, w: 12, h: 8 } },
            { id: 20, type: 'gauge', title: 'Temperature', gridPos: { x: 12, y: 2, w: 12, h: 8 } },
            { id: 201, type: 'timeseries', title: 'Pressure Trends', gridPos: { x: 12, y: 2, w: 12, h: 8 } },
            { id: 4, type: 'timeseries', title: 'Overview - Keysight', gridPos: { x: 0, y: 10, w: 24, h: 14 } },
            { id: 16, type: 'row', title: 'Stats', gridPos: { x: 0, y: 24, w: 24, h: 1 } },
            { id: 202, type: 'gauge', title: 'Cartridge Happiness Score', gridPos: { x: 0, y: 25, w: 24, h: 8 } },
        ];

        const applied = applyBestPracticeDashboardLayout(panels as Record<string, unknown>[], {
            dashboardTitle: '2505-200033 / Keysight',
        });

        expect(panelLooksLikeDashboardTitleRow(applied.panels[0] as Record<string, unknown>)).toBe(true);
        const pressure = applied.panels.find((p) => (p as { id?: number }).id === 200) as { gridPos: { y: number; x: number } };
        const trends = applied.panels.find((p) => (p as { id?: number }).id === 201) as { gridPos: { y: number; x: number } };
        expect(pressure.gridPos.y).toBe(2);
        expect(trends.gridPos.y).toBeGreaterThanOrEqual(10);
        expect(trends.gridPos.x).toBe(0);
        expect(applied.repositionedPanels).toBeGreaterThan(0);
    });
});

describe('leakedToolCallRecovery', () => {
    it('parses invoke markup', () => {
        const calls = parseLeakedToolCalls(
            'fetching\n<function_calls>\n<invoke name="get_dashboard_by_uid">\n<parameter name="uid">cfo0wckufbdhce</parameter>\n</invoke>'
        );
        expect(calls).toEqual([{ name: 'get_dashboard_by_uid', args: { uid: 'cfo0wckufbdhce' } }]);
    });
});

describe('formatDashboardRebuildExamplePrompt', () => {
    it('includes uid', () => {
        expect(formatDashboardRebuildExamplePrompt()).toContain('cfo0wckufbdhce');
    });
});
