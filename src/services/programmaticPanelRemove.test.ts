import { findPanelForRemoval, listDashboardPanels } from './panelDiscovery';
import { runProgrammaticPanelRemove } from './programmaticPanelRemove';

describe('findPanelForRemoval', () => {
    const entries = listDashboardPanels([
        { id: 1, title: 'Cartridge Happiness Score', type: 'gauge' },
        { id: 2, title: 'Temperature', type: 'gauge' },
    ]);

    it('matches Cartridge Happiness Panel query to Cartridge Happiness Score', () => {
        const hit = findPanelForRemoval(entries, 'Cartridge Happiness Panel');
        expect(hit?.panelId).toBe(1);
        expect(hit?.title).toBe('Cartridge Happiness Score');
    });
});

describe('runProgrammaticPanelRemove', () => {
    const dashboardJson = {
        uid: 'cfo0wckufbdhce',
        title: '2505-200033 / Keysight',
        version: 78,
        panels: [
            { id: 1, title: 'Cartridge Happiness Score', type: 'gauge', gridPos: { x: 0, y: 0, w: 12, h: 8 } },
            { id: 2, title: 'Temperature', type: 'gauge', gridPos: { x: 12, y: 0, w: 12, h: 8 } },
        ],
    };

    it('removes panel and verifies it is gone after save', async () => {
        let storedPanels = [...dashboardJson.panels];
        const client = {
            callTool: jest.fn(async ({ name }: { name: string }) => {
                if (name === 'get_dashboard_by_uid') {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    dashboard: { ...dashboardJson, panels: storedPanels, version: 79 },
                                }),
                            },
                        ],
                    };
                }
                if (name === 'update_dashboard') {
                    storedPanels = storedPanels.filter((p) => p.title !== 'Cartridge Happiness Score');
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ uid: 'cfo0wckufbdhce', version: 79 }) }],
                    };
                }
                throw new Error(`unexpected ${name}`);
            }),
        };

        const result = await runProgrammaticPanelRemove(client, {
            panelTitle: 'Cartridge Happiness',
            dashboardUid: 'cfo0wckufbdhce',
        });
        expect(result.ok).toBe(true);
        expect(result.removedPanelTitle).toBe('Cartridge Happiness Score');
        expect(storedPanels).toHaveLength(1);
        expect(storedPanels[0].title).toBe('Temperature');
    });
});
