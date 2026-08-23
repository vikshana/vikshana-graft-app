import { splitPanelsIntoChunks } from './dashboardCloneChunks';
import { updateCloneSessionMeta } from './cloneSessionStorage';
import {
    countPanelsInDashboard,
    formatDashboardCloneReply,
    inferSourceMachineIdFromDashboard,
    prepareClonedDashboard,
    replaceMachineLabelsInValue,
    runProgrammaticDashboardClone,
} from './programmaticDashboardClone';

describe('chunked clone sizing', () => {
    it('uses 6 chunks for 34 top-level panel slots', () => {
        const panels = Array.from({ length: 34 }, () => ({ type: 'timeseries' }));
        expect(splitPanelsIntoChunks(panels)).toHaveLength(6);
    });
});

describe('replaceMachineLabelsInValue', () => {
    it('replaces machine id in nested query strings', () => {
        const input = {
            panels: [
                {
                    targets: [{ expr: 'machine_metrics{machine="2103-176030"}' }],
                },
            ],
        };
        const out = replaceMachineLabelsInValue(input, '2103-176030', '2505-200033') as typeof input;
        expect(out.panels[0].targets[0].expr).toContain('2505-200033');
        expect(out.panels[0].targets[0].expr).not.toContain('2103-176030');
    });
});

describe('prepareClonedDashboard', () => {
    it('sets title and clears uid for new dashboards', () => {
        const source = { uid: 'abc', id: 1, title: '2103-176030 / Skywater-MN', panels: [] };
        const out = prepareClonedDashboard(source, {
            targetTitle: '2505-200033 / GlenTest',
            sourceMachine: '2103-176030',
            targetMachine: '2505-200033',
        });
        expect(out.title).toBe('2505-200033 / GlenTest');
        expect(out.uid).toBeUndefined();
        expect(out.id).toBeUndefined();
    });

    it('keeps uid and id when updating existing target', () => {
        const source = { uid: 'src', title: 'Old', panels: [] };
        const out = prepareClonedDashboard(source, {
            targetTitle: '2505-200033 / GlenTest',
            sourceMachine: '2103-176030',
            targetMachine: '2505-200033',
            targetUid: 'tgt',
            targetNumericId: 99,
        });
        expect(out.uid).toBe('tgt');
        expect(out.id).toBe(99);
    });
});

describe('countPanelsInDashboard', () => {
    it('counts non-row panels and nested row panels', () => {
        const n = countPanelsInDashboard({
            panels: [
                { type: 'timeseries' },
                { type: 'row', panels: [{ type: 'stat' }, { type: 'gauge' }] },
            ],
        });
        expect(n).toBe(3);
    });
});

describe('formatDashboardCloneReply', () => {
    it('reports a one-pass clone with no Continue needed', () => {
        const reply = formatDashboardCloneReply(
            {
                ok: true,
                targetUid: 'new-uid',
                panelCount: 34,
                targetTitle: '2505-200033 / Keysight',
                sourceMachine: '2103-176030',
                targetMachine: '2505-200033',
                totalChunks: 6,
                toolExecutions: [],
            },
            200
        );
        expect(reply).toContain('dashboard cloned');
        expect(reply).toContain('2505-200033 / Keysight');
        expect(reply).toContain('34');
        expect(reply).toMatch(/no need to type Continue/i);
    });
});

describe('runProgrammaticDashboardClone', () => {
    beforeEach(() => {
        sessionStorage.clear();
    });

    it('copies ALL panels in one turn (every batch) without manual Continue', async () => {
        const sourcePanels = Array.from({ length: 34 }, (_, i) => ({
            id: i + 1,
            type: 'timeseries',
            title: `Panel ${i + 1}`,
            targets: [{ refId: 'A', expr: `machine_metrics{machine="2103-176030"}` }],
            gridPos: { x: 0, y: i * 4, w: 12, h: 4 },
        }));

        const updateCalls: Array<Record<string, unknown>> = [];
        const mcpClient = {
            callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
                if (name === 'search_dashboards') {
                    const query = String(args.query ?? '');
                    if (query.includes('2103-176030')) {
                        return {
                            content: [
                                {
                                    type: 'text',
                                    text: JSON.stringify({
                                        dashboards: [{ uid: 'src-uid', title: '2103-176030 / Skywater-MN' }],
                                    }),
                                },
                            ],
                        };
                    }
                    return { content: [{ type: 'text', text: JSON.stringify({ dashboards: [] }) }] };
                }
                if (name === 'get_dashboard_by_uid') {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    dashboard: { uid: 'src-uid', id: 5, title: '2103-176030 / Skywater-MN', panels: sourcePanels },
                                    meta: { folderUid: 'folder1' },
                                }),
                            },
                        ],
                    };
                }
                if (name === 'update_dashboard') {
                    updateCalls.push(args);
                    return { content: [{ type: 'text', text: JSON.stringify({ uid: 'new-uid', version: updateCalls.length }) }] };
                }
                if (name === 'get_dashboard_summary') {
                    return { content: [{ type: 'text', text: JSON.stringify({ uid: 'new-uid', title: '2505-200033 / Keysight' }) }] };
                }
                throw new Error(`unexpected tool ${name}`);
            },
        };

        const result = await runProgrammaticDashboardClone(
            mcpClient,
            'Create dashboard "2505-200033 / Keysight" — copy of 2103-176030, with data for machine 2505-200033.'
        );

        expect(result.ok).toBe(true);
        expect(result.panelCount).toBe(34);
        expect(result.targetUid).toBe('new-uid');
        // 34 panels → 6 batches, all saved in this single call (no user "Continue").
        expect(updateCalls).toHaveLength(6);
        // Machine labels were remapped in the saved dashboard JSON (the batch message
        // legitimately names "source → target", so check the dashboard payload only).
        const firstDash = JSON.stringify(updateCalls[0].dashboard);
        expect(firstDash).toContain('2505-200033');
        expect(firstDash).not.toContain('2103-176030');
    });

    it('copies Skywater-FL by title, not a substring hit, and remaps the title machine id', async () => {
        const sourcePanels = [
            {
                id: 1,
                type: 'timeseries',
                title: 'Overview',
                targets: [{ refId: 'A', expr: 'machine_metrics{machine="2103-176030"}' }],
                gridPos: { x: 0, y: 0, w: 12, h: 8 },
            },
        ];
        const updateCalls: Array<Record<string, unknown>> = [];
        const mcpClient = {
            callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
                if (name === 'search_dashboards') {
                    const query = String(args.query ?? '');
                    if (/skywater-fl/i.test(query)) {
                        return {
                            content: [
                                {
                                    type: 'text',
                                    text: JSON.stringify({
                                        dashboards: [
                                            { uid: 'wrong-uid', title: 'Notes about Skywater-FL plant' },
                                            { uid: 'src-uid', title: '2103-176030 / Skywater-FL' },
                                        ],
                                    }),
                                },
                            ],
                        };
                    }
                    return { content: [{ type: 'text', text: JSON.stringify({ dashboards: [] }) }] };
                }
                if (name === 'get_dashboard_by_uid') {
                    expect(args.uid).toBe('src-uid');
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    dashboard: {
                                        uid: 'src-uid',
                                        title: '2103-176030 / Skywater-FL',
                                        panels: sourcePanels,
                                        annotations: { list: [{ text: 'see also 9999-000001' }] },
                                    },
                                    meta: { folderUid: 'folder1' },
                                }),
                            },
                        ],
                    };
                }
                if (name === 'update_dashboard') {
                    updateCalls.push(args);
                    return { content: [{ type: 'text', text: JSON.stringify({ uid: 'new-uid', version: 1 }) }] };
                }
                if (name === 'get_dashboard_summary') {
                    return { content: [{ type: 'text', text: JSON.stringify({ uid: 'new-uid', title: '2505-200033 / Keysight' }) }] };
                }
                throw new Error(`unexpected tool ${name}`);
            },
        };

        const result = await runProgrammaticDashboardClone(
            mcpClient,
            'I have a machine from Keysight for 2505-200033. Create a dashboard for it that is a copy of Skywater-FL, but with data for 2505-200033.'
        );

        expect(result.ok).toBe(true);
        const saved = JSON.stringify(updateCalls[0].dashboard);
        expect(saved).toContain('2505-200033');
        expect(saved).not.toContain('2103-176030');
        // Annotation ids must not be treated as the template machine (they stay put).
        expect(saved).toContain('9999-000001');
    });

    it('does not reuse a stale Keysight E2E sourceUid when the prompt names Skywater-FL', async () => {
        updateCloneSessionMeta({
            sourceUid: 'grafte2ekeysht',
            sourceTitle: '2505-200033 / Keysight — Graft E2E',
            sourceMachineId: '2105-172302',
            requestedMachine: '2505-200033',
        });
        const mcpClient = {
            callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
                if (name === 'search_dashboards') {
                    const query = String(args.query ?? '');
                    if (/skywater-fl/i.test(query)) {
                        return {
                            content: [
                                {
                                    type: 'text',
                                    text: JSON.stringify({
                                        dashboards: [{ uid: 'src-uid', title: '2103-176030 / Skywater-FL' }],
                                    }),
                                },
                            ],
                        };
                    }
                    return { content: [{ type: 'text', text: JSON.stringify({ dashboards: [] }) }] };
                }
                if (name === 'get_dashboard_by_uid') {
                    expect(args.uid).toBe('src-uid');
                    expect(args.uid).not.toBe('grafte2ekeysht');
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    dashboard: {
                                        uid: 'src-uid',
                                        title: '2103-176030 / Skywater-FL',
                                        panels: [
                                            {
                                                id: 1,
                                                type: 'timeseries',
                                                targets: [{ expr: 'machine_metrics{machine="2103-176030"}' }],
                                            },
                                        ],
                                    },
                                    meta: {},
                                }),
                            },
                        ],
                    };
                }
                if (name === 'update_dashboard') {
                    return { content: [{ type: 'text', text: JSON.stringify({ uid: 'new-uid', version: 1 }) }] };
                }
                if (name === 'get_dashboard_summary') {
                    return { content: [{ type: 'text', text: JSON.stringify({ uid: 'new-uid' }) }] };
                }
                throw new Error(`unexpected tool ${name}`);
            },
        };

        const result = await runProgrammaticDashboardClone(
            mcpClient,
            'I have a machine from Keysight for 2505-200033. Create a dashboard for it that is a copy of Skywater-FL, but with data for 2505-200033.'
        );
        expect(result.ok).toBe(true);
        expect(result.sourceMachine).toBe('2103-176030');
    });
});

describe('inferSourceMachineIdFromDashboard', () => {
    it('uses the title machine id, not the first id buried in JSON', () => {
        expect(
            inferSourceMachineIdFromDashboard({
                title: '2103-176030 / Skywater-FL',
                panels: [{ targets: [{ expr: 'machine="9999-000001"' }] }],
            })
        ).toBe('2103-176030');
    });

    it('uses a unique PromQL machine= label when the title has no id', () => {
        expect(
            inferSourceMachineIdFromDashboard({
                title: 'Skywater-FL',
                panels: [{ targets: [{ expr: 'machine_metrics{machine="2103-176030"}' }] }],
            })
        ).toBe('2103-176030');
    });

    it('does not guess when JSON contains several machine ids and the title has none', () => {
        expect(
            inferSourceMachineIdFromDashboard({
                title: 'Plant overview',
                panels: [
                    { targets: [{ expr: 'machine="2103-176030"' }] },
                    { targets: [{ expr: 'machine="2505-200033"' }] },
                ],
            })
        ).toBeUndefined();
    });
});
