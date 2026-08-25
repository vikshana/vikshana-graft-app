import {
    extractMetricNamesFromPrometheusQueryText,
    machineMetricsFieldSelectors,
    machinePrometheusSelectors,
    PROMETHEUS_DATASOURCE_LOOKUP_NAMES,
    resolveInfluxDatasourceUid,
    resolvePrometheusDatasourceUid,
} from './prometheusDiscovery';

describe('prometheusDiscovery', () => {
    it('builds MCP selector filters for machine and topic', () => {
        expect(machinePrometheusSelectors('2505-200033')).toEqual([
            { filters: [{ name: 'machine', value: '2505-200033', type: '=' }] },
            { filters: [{ name: 'topic', value: '2505-200033', type: '=' }] },
        ]);
    });

    it('builds machine_metrics field selectors for PowerTech exporter', () => {
        expect(machineMetricsFieldSelectors('2505-200033')).toEqual([
            {
                filters: [
                    { name: '__name__', value: 'machine_metrics', type: '=' },
                    { name: 'machine', value: '2505-200033', type: '=' },
                ],
            },
            {
                filters: [
                    { name: '__name__', value: 'machine_metrics', type: '=' },
                    { name: 'topic', value: '2505-200033', type: '=' },
                ],
            },
        ]);
    });

    it('extracts __name__ values from prometheus query JSON text', () => {
        const text =
            '[{"metric":{"__name__":"Pressure1_psi","machine":"2505-200033"},"value":[1710000000,"12"]}]';
        expect(extractMetricNamesFromPrometheusQueryText(text)).toEqual(['Pressure1_psi']);
    });

    it('resolveInfluxDatasourceUid falls back to list_datasources when panels are Prometheus-only', async () => {
        const mcp = {
            callTool: jest.fn(async ({ name }: { name: string }) => {
                if (name === 'list_datasources') {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify([
                                    { uid: 'p1', type: 'prometheus', name: 'Prometheus' },
                                    { uid: 'i1', type: 'influxdb', name: 'InfluxDB' },
                                ]),
                            },
                        ],
                    };
                }
                throw new Error(name);
            }),
        };
        const uid = await resolveInfluxDatasourceUid(mcp, [
            {
                datasource: { type: 'prometheus', uid: 'p1' },
                targets: [{ expr: 'up' }],
            },
        ]);
        expect(uid).toBe('i1');
    });

    it('includes ElectraMet sandbox Prometheus names in the lookup list', () => {
        expect(PROMETHEUS_DATASOURCE_LOOKUP_NAMES).toEqual(
            expect.arrayContaining(['Prometheus', 'ElectraMet Prometheus', 'Prometheus-ElectraMet'])
        );
    });

    it('resolves Prometheus from list_datasources when the dashboard is Influx-only', async () => {
        const mcp = {
            callTool: jest.fn(async ({ name }: { name: string }) => {
                if (name === 'list_datasources') {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify([
                                    { uid: 'influx-1', type: 'influxdb', name: 'InfluxDB' },
                                    { uid: 'prom-em', type: 'prometheus', name: 'ElectraMet Prometheus' },
                                ]),
                            },
                        ],
                    };
                }
                throw new Error(name);
            }),
        };
        const uid = await resolvePrometheusDatasourceUid(mcp, [
            {
                datasource: { type: 'influxdb', uid: 'influx-1' },
                targets: [{ query: 'from(bucket: v.bucket)' }],
            },
        ]);
        expect(uid).toBe('prom-em');
    });
});
