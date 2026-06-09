import {
    analyzeDashboardReadability,
    formatDashboardReviewReply,
    type DashboardReviewResult,
} from './programmaticDashboardReview';
import { DASHBOARD_REVIEW_EXAMPLE_PROMPT } from './dashboardReviewParse';
import { runProgrammaticDashboardReview } from './programmaticDashboardReview';

describe('analyzeDashboardReadability', () => {
    it('flags duplicate titles and missing row headers', () => {
        const panels = [
            { id: 1, type: 'stat', title: 'Level', gridPos: { x: 0, y: 0, w: 4, h: 4 } },
            { id: 2, type: 'stat', title: 'Level', gridPos: { x: 4, y: 0, w: 4, h: 4 } },
            { id: 3, type: 'timeseries', title: 'Sensing voltage A', gridPos: { x: 0, y: 4, w: 12, h: 8 } },
            { id: 4, type: 'timeseries', title: 'Sensing voltage B', gridPos: { x: 12, y: 4, w: 12, h: 8 } },
            { id: 5, type: 'timeseries', title: 'Sensing voltage C', gridPos: { x: 0, y: 12, w: 12, h: 8 } },
            { id: 6, type: 'stat', title: 'Pressure', gridPos: { x: 8, y: 0, w: 4, h: 4 } },
            { id: 7, type: 'stat', title: 'Temperature', gridPos: { x: 12, y: 0, w: 4, h: 4 } },
            { id: 8, type: 'stat', title: 'Cartridge', gridPos: { x: 16, y: 0, w: 4, h: 4 } },
        ];
        const suggestions = analyzeDashboardReadability(panels, 3);
        expect(suggestions).toHaveLength(3);
        expect(suggestions[0].title.toLowerCase()).toContain('duplicate');
        expect(suggestions.some((s) => /row header|consolidat/i.test(s.title + s.detail))).toBe(true);
    });
});

describe('formatDashboardReviewReply', () => {
    it('returns markdown suggestions without apply nudge', () => {
        const result: DashboardReviewResult = {
            ok: true,
            toolExecutions: [],
            dashboardUid: 'cfo0wckufbdhce',
            dashboardTitle: 'Keysight test',
            panelCount: 40,
            suggestions: [
                { title: 'Remove duplicate Level panels', detail: '3 duplicates.', priority: 90 },
                { title: 'Consolidate sensing voltage', detail: 'Merge 4 panels.', priority: 80 },
                { title: 'Add row headers', detail: 'Separate sections.', priority: 70 },
            ],
        };
        const text = formatDashboardReviewReply(result, 154);
        expect(text).toContain('readability suggestions');
        expect(text).toContain('Remove duplicate Level panels');
        expect(text).not.toMatch(/would you like|reply continue|apply these/i);
    });
});

describe('runProgrammaticDashboardReview', () => {
    it('fetches dashboard once and returns suggestions for the example prompt', async () => {
        const calls: string[] = [];
        const mcpClient = {
            callTool: async ({ name }: { name: string }) => {
                calls.push(name);
                if (name === 'get_dashboard_by_uid') {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    dashboard: {
                                        title: '2505-200033 / Keysight',
                                        uid: 'cfo0wckufbdhce',
                                        panels: [
                                            { id: 1, type: 'stat', title: 'Level', gridPos: { x: 0, y: 0, w: 4, h: 4 } },
                                            { id: 2, type: 'stat', title: 'Level', gridPos: { x: 4, y: 0, w: 4, h: 4 } },
                                            { id: 3, type: 'timeseries', title: 'Sensing voltage', gridPos: { x: 0, y: 4, w: 12, h: 8 } },
                                        ],
                                    },
                                }),
                            },
                        ],
                    };
                }
                throw new Error(`unexpected tool ${name}`);
            },
        };

        const req = {
            dashboardUid: 'cfo0wckufbdhce',
            suggestionCount: 3,
        };
        expect(DASHBOARD_REVIEW_EXAMPLE_PROMPT).toContain('cfo0wckufbdhce');

        const result = await runProgrammaticDashboardReview(mcpClient, req);
        expect(calls).toEqual(['get_dashboard_by_uid']);
        expect(result.ok).toBe(true);
        expect(result.suggestions.length).toBeGreaterThanOrEqual(1);
        expect(result.toolExecutions.some((t) => t.name === 'update_dashboard')).toBe(false);
    });
});
