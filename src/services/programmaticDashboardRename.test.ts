import { runProgrammaticDashboardRename } from './programmaticDashboardRename';
import type { DashboardRenameRequest } from './dashboardRenameParse';

describe('programmaticDashboardRename', () => {
    const request: DashboardRenameRequest = {
        machineId: '2505-200033',
        replaceLabel: 'Keysight',
        newLabel: 'NewMachine',
    };

    it('renames when search_dashboards returns JSON', async () => {
        let getCalls = 0;
        const mcpClient = {
            callTool: jest.fn(async ({ name }: { name: string; arguments: unknown }) => {
                if (name === 'search_dashboards') {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    dashboards: [{ uid: 'abc123', title: '2505-200033 / Keysight' }],
                                }),
                            },
                        ],
                    };
                }
                if (name === 'get_dashboard_by_uid') {
                    getCalls += 1;
                    const title = getCalls === 1 ? '2505-200033 / Keysight' : '2505-200033 / NewMachine';
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    dashboard: {
                                        uid: 'abc123',
                                        title,
                                        version: getCalls === 1 ? 3 : 4,
                                        panels: [],
                                    },
                                }),
                            },
                        ],
                    };
                }
                if (name === 'update_dashboard') {
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ uid: 'abc123', version: 4 }) }],
                    };
                }
                throw new Error(`unexpected tool ${name}`);
            }),
        };

        const result = await runProgrammaticDashboardRename(mcpClient, request);
        expect(result.ok).toBe(true);
        expect(result.newTitle).toBe('2505-200033 / NewMachine');
    });

    it('asks for clarification when search returns no JSON hits', async () => {
        const mcpClient = {
            callTool: jest.fn(async () => ({
                content: [{ type: 'text', text: 'No dashboards found' }],
            })),
        };

        const result = await runProgrammaticDashboardRename(mcpClient, request);
        expect(result.ok).toBe(false);
        expect(result.clarification).toBe(true);
        expect(result.error).toContain('Need clarification');
        expect(result.error).toContain('2505-200033');
    });
});
