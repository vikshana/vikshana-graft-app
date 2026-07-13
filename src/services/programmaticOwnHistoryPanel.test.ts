import { runProgrammaticAddOwnHistoryPanel } from './programmaticOwnHistoryPanel';

interface SavedPanel {
    title?: string;
    fieldConfig?: { defaults?: { unit?: string } };
    targets?: Array<{ query?: string }>;
}

function fluxPanel(opts: { id: number; title: string; field: string; unit?: string }) {
    return {
        id: opts.id,
        title: opts.title,
        type: 'timeseries',
        gridPos: { x: 0, y: 0, w: 12, h: 8 },
        datasource: { type: 'influxdb', uid: 'ffmk2neut49vkf' },
        fieldConfig: { defaults: { unit: opts.unit ?? 'none' } },
        targets: [
            {
                refId: 'A',
                datasource: { type: 'influxdb', uid: 'ffmk2neut49vkf' },
                rawQuery: true,
                query: `from(bucket: v.bucket)\n  |> filter(fn: (r) => r.machine == "2505-200033" and r._field == "${opts.field}")\n  |> aggregateWindow(every: v.windowPeriod, fn: mean, createEmpty: false)`,
            },
        ],
    };
}

function client(capture: { saved?: { panels?: SavedPanel[] } }, extraPanels: object[] = []) {
    const dashboard = {
        uid: 'afq7tc6hl1m9sb',
        title: '2505-200033 / Keysight',
        version: 11,
        panels: [
            fluxPanel({ id: 1, title: 'Module 5 Current', field: 'Module5_Current_A', unit: 'amp' }),
            ...extraPanels,
        ],
    };
    return {
        callTool: jest.fn(async ({ name, arguments: args }: { name: string; arguments: unknown }) => {
            if (name === 'get_dashboard_by_uid') {
                return { content: [{ type: 'text', text: JSON.stringify({ dashboard }) }] };
            }
            if (name === 'update_dashboard') {
                capture.saved = (args as { dashboard?: { panels?: SavedPanel[] } }).dashboard;
                return { content: [{ type: 'text', text: JSON.stringify({ uid: dashboard.uid, version: 12 }) }] };
            }
            throw new Error(`unexpected tool ${name}`);
        }),
    };
}

describe('runProgrammaticAddOwnHistoryPanel — target metric', () => {
    it('builds Pressure bands from the dashboard Pressure panel, not Module 5', async () => {
        const capture: { saved?: { panels?: SavedPanel[] } } = {};
        const pressure = fluxPanel({ id: 2, title: 'Pressure', field: 'Pressure_PSI', unit: 'pressurehpa' });
        const result = await runProgrammaticAddOwnHistoryPanel(client(capture, [pressure]), {
            dashboardUid: 'afq7tc6hl1m9sb',
            metricLabel: 'Pressure',
        });
        expect(result.ok).toBe(true);
        expect(result.panelTitle).toBe('Pressure — vs. Own History (± 2σ)');
        const added = capture.saved?.panels?.find((p) => p.title === 'Pressure — vs. Own History (± 2σ)');
        const blob = JSON.stringify(added);
        expect(blob).toContain('Pressure_PSI');
        expect(blob).not.toContain('Module5_Current_A');
        expect(blob).toContain('Pressure (Actual)');
        expect(added?.fieldConfig?.defaults?.unit).toBe('pressurehpa');
    });

    it('errors clearly when no source panel exists for the named metric', async () => {
        const capture: { saved?: { panels?: SavedPanel[] } } = {};
        const result = await runProgrammaticAddOwnHistoryPanel(client(capture), {
            dashboardUid: 'afq7tc6hl1m9sb',
            metricLabel: 'Pressure',
        });
        expect(result.ok).toBe(false);
        expect(result.error).toContain('Pressure');
        expect(capture.saved).toBeUndefined();
    });

    it('module path still targets the requested module field', async () => {
        const capture: { saved?: { panels?: SavedPanel[] } } = {};
        const mod3 = fluxPanel({ id: 3, title: 'Module 3 Current', field: 'Module3_Current_A', unit: 'amp' });
        const result = await runProgrammaticAddOwnHistoryPanel(client(capture, [mod3]), {
            dashboardUid: 'afq7tc6hl1m9sb',
            moduleNumber: 3,
        });
        expect(result.ok).toBe(true);
        expect(result.panelTitle).toBe('Module 3 Current — vs. Own History (± 2σ)');
        const added = capture.saved?.panels?.find((p) => p.title === 'Module 3 Current — vs. Own History (± 2σ)');
        expect(JSON.stringify(added)).toContain('Module3_Current_A');
    });

    it('Alert Test custom title builds four Flux targets with mean ± 2σ in the query', async () => {
        const capture: { saved?: { panels?: SavedPanel[] } } = {};
        const customTitle = 'Module 1 Current — Alert Test Own History ±2σ';
        const result = await runProgrammaticAddOwnHistoryPanel(client(capture), {
            dashboardUid: 'afq7tc6hl1m9sb',
            moduleNumber: 1,
            panelTitle: customTitle,
        });
        expect(result.ok).toBe(true);
        expect(result.panelTitle).toBe(customTitle);
        const added = capture.saved?.panels?.find((p) => p.title === customTitle);
        expect(added?.targets).toHaveLength(4);
        const blob = JSON.stringify(added);
        expect(blob).toContain('Module1_Current_A');
        expect(blob).toContain('2505-200033');
        expect(blob).toContain('stddev');
        expect(blob).toContain('(2.0 * r.std)');
        expect(blob).toContain('Upper Bound (±2σ)');
        expect(blob).toContain('Lower Bound (±2σ)');
        expect(blob).toContain('Historical Mean');
        expect(blob).toContain('Module 1 (Actual)');
        expect(blob).not.toContain('Module5_Current_A');
    });
});
