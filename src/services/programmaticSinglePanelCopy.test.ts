import { runProgrammaticSinglePanelCopy } from './programmaticSinglePanelCopy';
import type { SinglePanelCopyRequest } from './singlePanelCopyParse';

describe('programmaticSinglePanelCopy', () => {
    const sourceDashboard = {
        title: '2210-177097',
        uid: 'ee89e3vy1nourk',
        panels: [
            {
                id: 1,
                title: 'Pressure',
                type: 'timeseries',
                gridPos: { h: 8, w: 12, x: 0, y: 0 },
                targets: [
                    {
                        expr: 'machine_metrics{machine="2210-177097", field="Pressure"}',
                        refId: 'A',
                    },
                ],
            },
        ],
    };

    const targetDashboard = {
        title: '2505-200033',
        uid: 'fe89f4vy2opvsl',
        panels: [],
    };

    const request: SinglePanelCopyRequest = {
        panelTitle: 'Pressure',
        sourceDashboardUid: 'ee89e3vy1nourk',
        targetDashboardUid: 'fe89f4vy2opvsl',
        sourceMachineId: '2210-177097',
        targetMachineId: '2505-200033',
        replaceExisting: true,
    };

    it('copies and remaps panel queries', async () => {
        const client = {
            callTool: jest.fn(async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
                if (name === 'get_dashboard_by_uid') {
                    const uid = args.uid as string;
                    const dashboard = uid === 'ee89e3vy1nourk' ? sourceDashboard : targetDashboard;
                    return { content: [{ type: 'text', text: JSON.stringify({ dashboard }) }] };
                }
                if (name === 'update_dashboard') {
                    const dash = (args.dashboard as { panels?: Array<{ targets?: Array<{ expr?: string }> }> }) ?? {};
                    const panel = dash.panels?.[0];
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({ status: 'success', version: 4, uid: 'fe89f4vy2opvsl', panel }),
                            },
                        ],
                    };
                }
                throw new Error(`unexpected tool ${name}`);
            }),
        };

        const result = await runProgrammaticSinglePanelCopy(client, request);
        expect(result.ok).toBe(true);
        expect(result.action).toBe('appended');
        expect(result.panelTitle).toBe('Pressure');
        expect(client.callTool).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'update_dashboard' })
        );

        const updateCall = (client.callTool as jest.Mock).mock.calls.find(
            (c: [{ name: string }]) => c[0].name === 'update_dashboard'
        );
        const savedPanel = (updateCall[0].arguments.dashboard as { panels: Array<{ targets: Array<{ expr: string }> }> })
            .panels[0];
        expect(savedPanel.targets[0].expr).toContain('machine="2505-200033"');
        expect(savedPanel.targets[0].expr).not.toContain('2210-177097');
    });
});
