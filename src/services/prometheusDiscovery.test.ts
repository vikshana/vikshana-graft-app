import {
    extractMetricNamesFromPrometheusQueryText,
    machinePrometheusSelectors,
} from './prometheusDiscovery';

describe('prometheusDiscovery', () => {
    it('builds MCP selector filters for machine and topic', () => {
        expect(machinePrometheusSelectors('2505-200033')).toEqual([
            { filters: [{ name: 'machine', value: '2505-200033', type: '=' }] },
            { filters: [{ name: 'topic', value: '2505-200033', type: '=' }] },
        ]);
    });

    it('extracts __name__ values from prometheus query JSON text', () => {
        const text =
            '[{"metric":{"__name__":"Pressure1_psi","machine":"2505-200033"},"value":[1710000000,"12"]}]';
        expect(extractMetricNamesFromPrometheusQueryText(text)).toEqual(['Pressure1_psi']);
    });
});
