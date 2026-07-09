import { runProgrammaticPanelRename } from './programmaticPanelRename';
import type { PanelRenameRequest } from './panelRenameParse';

describe('programmaticPanelRename', () => {
    const request: PanelRenameRequest = {
        currentPanelTitle: 'Pressure Gauge',
        newPanelTitle: 'System Pressure',
        dashboardUid: 'cfo0wckufbdhce',
    };

    const dashboardJson = {
        uid: 'cfo0wckufbdhce',
        title: '2505-200033 / Keysight',
        version: 69,
        panels: [
            { id: 10, title: 'Pressure Gauge', type: 'timeseries', gridPos: { x: 0, y: 2, w: 12, h: 8 } },
            { id: 11, title: 'Other', type: 'stat', gridPos: { x: 12, y: 2, w: 12, h: 8 } },
        ],
    };

    function mcpClient() {
        let savedTitle: string | undefined;
        return {
            callTool: jest.fn(async ({ name, arguments: args }: { name: string; arguments: unknown }) => {
                if (name === 'get_dashboard_by_uid') {
                    const uid = (args as { uid?: string }).uid ?? 'cfo0wckufbdhce';
                    const panels = [...dashboardJson.panels];
                    if (savedTitle) {
                        panels[0] = { ...panels[0], title: savedTitle };
                    }
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    dashboard: {
                                        ...dashboardJson,
                                        uid,
                                        title: dashboardJson.title,
                                        version: savedTitle ? 70 : dashboardJson.version,
                                        panels,
                                    },
                                }),
                            },
                        ],
                    };
                }
                if (name === 'update_dashboard') {
                    const dash = (args as { dashboard?: { panels?: { title?: string }[] } }).dashboard;
                    savedTitle = dash?.panels?.[0]?.title;
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ uid: 'cfo0wckufbdhce', version: 70 }) }],
                    };
                }
                throw new Error(`unexpected tool ${name}`);
            }),
        };
    }

    it('renames only the panel title and leaves dashboard title unchanged', async () => {
        const result = await runProgrammaticPanelRename(mcpClient(), request);
        expect(result.ok).toBe(true);
        expect(result.previousPanelTitle).toBe('Pressure Gauge');
        expect(result.newPanelTitle).toBe('System Pressure');
        expect(result.dashboardTitle).toBe('2505-200033 / Keysight');
        expect(result.version).toBe(70);
        expect(result.toolExecutions).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ name: 'update_dashboard', status: 'success' }),
            ])
        );
    });

    it('renames Pressure Gauge not shorter Pressure when both exist', async () => {
        const withPressure = {
            ...dashboardJson,
            panels: [
                { id: 200, title: 'Pressure', type: 'gauge', gridPos: { x: 0, y: 0, w: 6, h: 6 } },
                { id: 201, title: 'Pressure Gauge', type: 'gauge', gridPos: { x: 6, y: 0, w: 6, h: 6 } },
            ],
        };
        let savedPanelId: number | undefined;
        let savedPanels: { id?: number; title?: string }[] | undefined;
        const client = {
            callTool: jest.fn(async ({ name, arguments: args }: { name: string; arguments: unknown }) => {
                if (name === 'get_dashboard_by_uid') {
                    // Reflect the persisted rename on re-fetch so the post-save
                    // verification step can confirm the new title.
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    dashboard: {
                                        ...withPressure,
                                        version: savedPanels ? 71 : withPressure.version,
                                        panels: savedPanels ?? withPressure.panels,
                                    },
                                }),
                            },
                        ],
                    };
                }
                if (name === 'update_dashboard') {
                    const dash = (args as { dashboard?: { panels?: { id?: number; title?: string }[] } })
                        .dashboard;
                    savedPanels = dash?.panels;
                    const renamed = dash?.panels?.find((p) => p.title === 'System Pressure');
                    savedPanelId = renamed?.id;
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ uid: 'cfo0wckufbdhce', version: 71 }) }],
                    };
                }
                throw new Error(`unexpected tool ${name}`);
            }),
        };
        const result = await runProgrammaticPanelRename(client, request);
        expect(result.ok).toBe(true);
        expect(result.previousPanelTitle).toBe('Pressure Gauge');
        expect(savedPanelId).toBe(201);
    });

    it('returns clarification when panel is missing', async () => {
        const result = await runProgrammaticPanelRename(mcpClient(), {
            ...request,
            currentPanelTitle: 'Missing Panel',
        });
        expect(result.ok).toBe(false);
        expect(result.clarification).toBe(true);
        expect(result.error).toContain('could not find a matching panel');
    });

    it('renames the data panel when a row header shares the same title', async () => {
        const skywater = {
            uid: 'idHkqdqnkmfv',
            title: '2103-176030 / Skywater-MN Test',
            version: 3,
            panels: [
                { id: 1, title: 'Levels', type: 'row', gridPos: { x: 0, y: 0, w: 24, h: 1 }, panels: [] },
                { id: 2, title: 'Levels', type: 'timeseries', gridPos: { x: 0, y: 1, w: 12, h: 8 } },
            ],
        };
        let savedPanels: { id?: number; title?: string }[] | undefined;
        const client = {
            callTool: jest.fn(async ({ name, arguments: args }: { name: string; arguments: unknown }) => {
                if (name === 'get_dashboard_by_uid') {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    dashboard: {
                                        ...skywater,
                                        version: savedPanels ? 4 : skywater.version,
                                        panels: savedPanels ?? skywater.panels,
                                    },
                                }),
                            },
                        ],
                    };
                }
                if (name === 'update_dashboard') {
                    savedPanels = (args as { dashboard?: { panels?: { id?: number; title?: string }[] } }).dashboard
                        ?.panels;
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ uid: skywater.uid, version: 4 }) }],
                    };
                }
                throw new Error(`unexpected tool ${name}`);
            }),
        };
        const result = await runProgrammaticPanelRename(client, {
            currentPanelTitle: 'Levels',
            newPanelTitle: 'Machine Levels',
            dashboardUid: 'idHkqdqnkmfv',
        });
        expect(result.ok).toBe(true);
        expect(result.panelId).toBe(2);
        expect(savedPanels?.find((p) => p.id === 1)?.title).toBe('Levels');
        expect(savedPanels?.find((p) => p.id === 2)?.title).toBe('Machine Levels');
    });
});
