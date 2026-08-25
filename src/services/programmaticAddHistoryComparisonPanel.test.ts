import { runProgrammaticAddHistoryComparisonPanel } from './programmaticAddHistoryComparisonPanel';

interface SavedPanel {
    title?: string;
    targets?: Array<{ expr?: string }>;
}

function promRef(title: string, field: string, machine: string) {
    return {
        id: 1,
        title,
        type: 'timeseries',
        gridPos: { x: 0, y: 0, w: 24, h: 12 },
        datasource: { type: 'prometheus', uid: 'prom-keysight' },
        targets: [
            {
                refId: 'A',
                datasource: { type: 'prometheus', uid: 'prom-keysight' },
                expr: `machine_metrics{machine="${machine}",field="${field}"}`,
            },
            {
                refId: 'B',
                datasource: { type: 'prometheus', uid: 'prom-keysight' },
                expr: `last_over_time(machine_metric_upper_bound{machine="${machine}",field="${field}"}[6m])`,
            },
        ],
    };
}

function client(capture: { saved?: { panels?: SavedPanel[] } }) {
    const dashboard = {
        uid: 'afq7tc6hl1m9sb',
        title: '2505-200033 / Keysight',
        version: 31,
        panels: [promRef('Module 5 Current — History Comparison', 'Module5_Current_A', '2505-200033')],
    };
    return {
        callTool: jest.fn(async ({ name, arguments: args }: { name: string; arguments: unknown }) => {
            if (name === 'get_dashboard_by_uid') {
                return { content: [{ type: 'text', text: JSON.stringify({ dashboard }) }] };
            }
            if (name === 'update_dashboard') {
                capture.saved = (args as { dashboard?: { panels?: SavedPanel[] } }).dashboard;
                return { content: [{ type: 'text', text: JSON.stringify({ uid: dashboard.uid, version: 32 }) }] };
            }
            throw new Error(`unexpected tool ${name}`);
        }),
    };
}

function influxOnlyClient(capture: { saved?: { panels?: SavedPanel[] } }) {
    const dashboard = {
        uid: 'idHkqdqnk',
        title: '2505-200033 / Keysight',
        version: 40,
        panels: [
            {
                id: 1,
                title: 'Module 1 Current',
                type: 'timeseries',
                datasource: { type: 'influxdb', uid: 'influx-keysight' },
                targets: [
                    {
                        refId: 'A',
                        datasource: { type: 'influxdb', uid: 'influx-keysight' },
                        query: 'from(bucket: v.bucket)',
                    },
                ],
            },
        ],
    };
    return {
        callTool: jest.fn(async ({ name, arguments: args }: { name: string; arguments: unknown }) => {
            if (name === 'get_dashboard_by_uid') {
                return { content: [{ type: 'text', text: JSON.stringify({ dashboard }) }] };
            }
            if (name === 'list_datasources') {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify([
                                { uid: 'influx-keysight', type: 'influxdb', name: 'InfluxDB' },
                                { uid: 'prom-keysight', type: 'prometheus', name: 'Prometheus' },
                            ]),
                        },
                    ],
                };
            }
            if (name === 'update_dashboard') {
                capture.saved = (args as { dashboard?: { panels?: SavedPanel[] } }).dashboard;
                return { content: [{ type: 'text', text: JSON.stringify({ uid: dashboard.uid, version: 41 }) }] };
            }
            throw new Error(`unexpected tool ${name}`);
        }),
    };
}

describe('runProgrammaticAddHistoryComparisonPanel', () => {
    it('adds Module 2 Current — History Comparison with PromQL RF bands', async () => {
        const capture: { saved?: { panels?: SavedPanel[] } } = {};
        const result = await runProgrammaticAddHistoryComparisonPanel(client(capture), {
            dashboardUid: 'afq7tc6hl1m9sb',
            moduleNumber: 2,
        });
        expect(result.ok).toBe(true);
        expect(result.panelTitle).toBe('Module 2 Current — History Comparison');
        const added = capture.saved?.panels?.find((p) => p.title === 'Module 2 Current — History Comparison');
        const blob = JSON.stringify(added);
        expect(blob).toContain('Module2_Current_A');
        expect(blob).toContain('machine_metric_upper_bound');
        expect(blob).toContain('2505-200033');
        expect(blob).not.toContain('Module5_Current_A');
    });

    it('adds Sensing Voltage — History Comparison for Random Forest sensing-voltage prompts', async () => {
        const capture: { saved?: { panels?: SavedPanel[] } } = {};
        const result = await runProgrammaticAddHistoryComparisonPanel(client(capture), {
            dashboardUid: 'afq7tc6hl1m9sb',
            metricLabel: 'sensing voltage',
            signal: {
                field: 'Cartridge_Sensing_Voltage',
                titleBase: 'Sensing Voltage',
                panelTitle: 'Sensing Voltage — History Comparison',
                unit: 'volt',
            },
        });
        expect(result.ok).toBe(true);
        expect(result.panelTitle).toBe('Sensing Voltage — History Comparison');
        const added = capture.saved?.panels?.find((p) => p.title === 'Sensing Voltage — History Comparison');
        const blob = JSON.stringify(added);
        expect(blob).toContain('Cartridge_Sensing_Voltage');
        expect(blob).toContain('machine_metric_upper_bound');
        expect(blob).toContain('"unit":"volt"');
        expect(blob).not.toContain('Module5_Current_A');
        expect(blob).not.toContain('Module 5 Current');
    });

    it('resolves Prometheus via list_datasources when the dashboard has only Influx panels', async () => {
        const capture: { saved?: { panels?: SavedPanel[] } } = {};
        const result = await runProgrammaticAddHistoryComparisonPanel(influxOnlyClient(capture), {
            dashboardUid: 'idHkqdqnk',
            moduleNumber: 1,
        });
        expect(result.ok).toBe(true);
        expect(result.panelTitle).toMatch(/Module 1 Current/i);
        expect(result.panelTitle).toMatch(/History Comparison/i);
        const added = capture.saved?.panels?.find((p) => /History Comparison/i.test(p.title ?? ''));
        const blob = JSON.stringify(added);
        expect(blob).toContain('prom-keysight');
        expect(blob).toContain('Module1_Current_A');
        expect(blob).not.toContain('influx-keysight');
    });
});
