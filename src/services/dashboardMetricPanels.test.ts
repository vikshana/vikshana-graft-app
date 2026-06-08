import {
    formatDashboardMetricPanelsExamplePrompt,
    parseDashboardMetricPanelsRequest,
    userWantsDashboardMetricPanels,
} from './dashboardMetricPanelsParse';
import { extractMetricsFromPanels } from './instrumentationMetricDiscovery';
import { KNOWN_INSTRUMENTATION_DASHBOARD_UIDS } from './programmaticDashboardResolve';

describe('dashboardMetricPanelsParse', () => {
    it('parses create 50 panels prompt', () => {
        const req = parseDashboardMetricPanelsRequest(
            'Create 50 panels covering every available metric on the dashboard with UID = cfo0wckufbdhce'
        );
        expect(req).toEqual({
            dashboardUid: 'cfo0wckufbdhce',
            dashboardTitle: undefined,
            titleLabel: undefined,
            machineId: undefined,
            maxPanels: 50,
        });
        expect(userWantsDashboardMetricPanels(
            'Create 50 panels covering every available metric on the dashboard with UID = cfo0wckufbdhce'
        )).toBe(true);
    });

    it('parses Keysight metric coverage without uid', () => {
        const req = parseDashboardMetricPanelsRequest(
            'Add panels for every available metric that monitors the Keysight machine on dashboard 2505-200033 / Keysight'
        );
        expect(req?.titleLabel).toBe('Keysight');
        expect(req?.maxPanels).toBe(50);
    });

    it('includes uid in example prompt', () => {
        expect(formatDashboardMetricPanelsExamplePrompt()).toContain('cfo0wckufbdhce');
    });
});

describe('instrumentationMetricDiscovery', () => {
    it('extracts Prometheus metrics from panel expr', () => {
        const panels = [
            {
                id: 10,
                type: 'stat',
                title: 'Pressure 1',
                datasource: { type: 'prometheus', uid: 'prom-1' },
                targets: [{ refId: 'A', expr: 'Pressure1_psi{machine="2505-200033"}' }],
            },
            {
                id: 11,
                type: 'stat',
                title: 'Temperature',
                targets: [{ refId: 'A', expr: 'Temperature_C{machine="2505-200033"}' }],
            },
        ];
        const metrics = extractMetricsFromPanels(panels, '2505-200033');
        expect(metrics.map((m) => m.key)).toEqual(['prom:Pressure1_psi', 'prom:Temperature_C']);
        expect(metrics[0].expr).toBe('Pressure1_psi{machine="2505-200033"}');
    });

    it('extracts machine_metrics field from panel expr', () => {
        const panels = [
            {
                id: 12,
                type: 'timeseries',
                title: 'Flow 1',
                datasource: { type: 'prometheus', uid: 'prom-1' },
                targets: [
                    {
                        refId: 'A',
                        expr: 'machine_metrics{machine="2505-200033", field="Flow1_gpm"}',
                    },
                ],
            },
        ];
        const metrics = extractMetricsFromPanels(panels, '2505-200033');
        expect(metrics.map((m) => m.key)).toEqual(['field:Flow1_gpm']);
        expect(metrics[0].expr).toBe('machine_metrics{machine="2505-200033", field="Flow1_gpm"}');
    });
});

describe('programmaticDashboardResolve', () => {
    it('maps Keysight label to known uid', () => {
        expect(KNOWN_INSTRUMENTATION_DASHBOARD_UIDS.keysight).toBe('cfo0wckufbdhce');
    });
});
