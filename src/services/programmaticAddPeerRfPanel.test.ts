import { runProgrammaticAddPeerRfPanel } from './programmaticAddPeerRfPanel';

interface SavedPanel {
    title?: string;
    targets?: Array<{ query?: string }>;
}

function fluxRef(title: string, field: string) {
    return {
        id: 1,
        title,
        type: 'timeseries',
        gridPos: { x: 0, y: 0, w: 24, h: 10 },
        datasource: { type: 'influxdb', uid: 'ffmk2neut49vkf' },
        targets: [
            {
                refId: 'A',
                datasource: { type: 'influxdb', uid: 'ffmk2neut49vkf' },
                rawQuery: true,
                query: `from(bucket: v.bucket)\n  |> filter(fn: (r) => r.machine == "2406-176021" and r._field == "${field}")`,
            },
        ],
    };
}

function client(capture: { saved?: { panels?: SavedPanel[] } }) {
    const dashboard = {
        uid: 'afq7tc6hl1m9sb',
        title: '2505-200033 / Keysight',
        version: 7,
        panels: [fluxRef('Module 5 Current — vs. Peer Band (Modules 1–4,6–8 Avg ± 2σ)', 'Module5_Current_A')],
    };
    return {
        callTool: jest.fn(async ({ name, arguments: args }: { name: string; arguments: unknown }) => {
            if (name === 'get_dashboard_by_uid') {
                return { content: [{ type: 'text', text: JSON.stringify({ dashboard }) }] };
            }
            if (name === 'update_dashboard') {
                capture.saved = (args as { dashboard?: { panels?: SavedPanel[] } }).dashboard;
                return { content: [{ type: 'text', text: JSON.stringify({ uid: dashboard.uid, version: 8 }) }] };
            }
            throw new Error(`unexpected tool ${name}`);
        }),
    };
}

describe('runProgrammaticAddPeerRfPanel — module scope', () => {
    it('creates a panel for the requested module (3), not Module 5', async () => {
        const capture: { saved?: { panels?: SavedPanel[] } } = {};
        const result = await runProgrammaticAddPeerRfPanel(client(capture), {
            dashboardUid: 'afq7tc6hl1m9sb',
            machineId: '2505-200033',
            moduleNumber: 3,
        });
        expect(result.ok).toBe(true);
        expect(result.panelTitle).toBe('Module 3 Current — RandomForest vs Peers (Influx)');
        const added = capture.saved?.panels?.find((p) => p.title?.includes('RandomForest vs Peers'));
        const blob = JSON.stringify(added);
        expect(blob).toContain('Module3_Current_A');
        expect(blob).not.toContain('Module5_Current_A');
        expect(blob).toContain('Module 3 (Actual)');
        expect(blob).toContain('2505-200033');
    });

    it('defaults to Module 5 when no module is given', async () => {
        const capture: { saved?: { panels?: SavedPanel[] } } = {};
        const result = await runProgrammaticAddPeerRfPanel(client(capture), {
            dashboardUid: 'afq7tc6hl1m9sb',
            machineId: '2505-200033',
        });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/Which module/i);
    });

    it('uses machine id from Keysight dashboard title when request omits machineId', async () => {
        const capture: { saved?: { panels?: SavedPanel[] } } = {};
        const result = await runProgrammaticAddPeerRfPanel(client(capture), {
            dashboardUid: 'afq7tc6hl1m9sb',
            moduleNumber: 2,
        });
        expect(result.ok).toBe(true);
        expect(result.machineId).toBe('2505-200033');
        const added = capture.saved?.panels?.find((p) => p.title?.includes('RandomForest vs Peers'));
        const blob = JSON.stringify(added);
        expect(blob).toContain('2505-200033');
        expect(blob).not.toContain('2406-176021');
        expect(blob).toContain('Module2_Current_A');
        expect(added?.targets?.length).toBe(4);
        expect(added?.targets?.every((t) => Boolean(t.query))).toBe(true);
    });
});
