import {
    applyModule5PeerBandFluxFixes,
    defaultPeerFieldsForActual,
    inferActualFieldFromPanelTitle,
    inferPeerModuleNumbersFromPanel,
    isHistoryComparisonPanel,
    isPeerBandPanel,
    panelUsesPrometheusPeerBandQueries,
    stripFluxMachineMetricsMeasurement,
} from './fluxPeerBandFix';

const build61Panel = {
    id: 424,
    title: 'Module 5 Current — vs. Peer Band (Modules 1–4,6–8 Avg ± 2σ)',
    targets: [
        {
            refId: 'A',
            query:
                'from(bucket: v.bucket)\n  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)\n  |> filter(fn: (r) =>\n    r._measurement == "machine_metrics" and\n    r.machine == "2406-176021" and\n    r._field == "Module5_Current_A"\n  )\n  |> keep(columns: ["_time", "_value"])',
        },
        {
            refId: 'B',
            legendFormat: 'Peer Avg',
            query:
                'union(tables: [from(bucket: v.bucket) |> range(start: v.timeRangeStart, stop: v.timeRangeStop) |> filter(fn: (r) => r._measurement == "machine_metrics" and r.machine == "2406-176021" and r._field == "Module1_Current_A") |> keep(columns: ["_time", "_value"])]) |> group(columns: ["_time"]) |> mean(column: "_value")',
        },
        {
            refId: 'C',
            legendFormat: 'Upper Band',
            query:
                'union(tables: [from(bucket: v.bucket) |> range(start: v.timeRangeStart, stop: v.timeRangeStop) |> filter(fn: (r) => r._measurement == "machine_metrics" and r.machine == "2406-176021" and r._field == "Module1_Current_A") |> keep(columns: ["_time", "_value"])]) |> group(columns: ["_time"]) |> mean(column: "_value")',
        },
        {
            refId: 'D',
            legendFormat: 'Lower Band',
            query:
                'union(tables: [from(bucket: v.bucket) |> range(start: v.timeRangeStart, stop: v.timeRangeStop) |> filter(fn: (r) => r._measurement == "machine_metrics" and r.machine == "2406-176021" and r._field == "Module1_Current_A") |> keep(columns: ["_time", "_value"])]) |> group(columns: ["_time"]) |> mean(column: "_value")',
        },
    ],
};

describe('stripFluxMachineMetricsMeasurement', () => {
    it('removes multiline and inline measurement predicates', () => {
        const q =
            'filter(fn: (r) =>\n    r._measurement == "machine_metrics" and\n    r.machine == "m" and\n    r._field == "X"\n  )';
        expect(stripFluxMachineMetricsMeasurement(q)).not.toMatch(/_measurement/);
        expect(stripFluxMachineMetricsMeasurement(q)).toContain('r.machine == "m"');
    });
});

describe('applyModule5PeerBandFluxFixes build 72', () => {
    it('merges per-_time tables with group() after mean for Grafana', () => {
        const { panel, changed } = applyModule5PeerBandFluxFixes(build61Panel, { force: true });
        expect(changed).toBe(true);
        const targets = panel.targets as { refId: string; query: string }[];
        expect(targets[1].query).toMatch(
            /\|\>\s*mean\s*\([^)]*\)\s*\n\s*\|\>\s*group\s*\(\s*\)\s*\n\s*\|\>\s*map/
        );
        expect(targets[2].query).toMatch(/\|\>\s*group\s*\(\s*\)\s*\n\s*\|\>\s*map\(fn: \(r\) => \(\{ _time: r\._time, _value: r\._value, _field: "Upper Band"/);
    });

    it('derives Module 3 peer fields excluding self', () => {
        expect(inferActualFieldFromPanelTitle('Module 3 Current — vs. Peer Band (Modules 1–4,6–8 Avg ± 2σ)')).toBe(
            'Module3_Current_A'
        );
        expect(defaultPeerFieldsForActual('Module3_Current_A')).not.toContain('Module3_Current_A');
        // Peer band is "Modules 1–4,6–8" — Module 5 is the excluded anomaly module,
        // never a peer. Self (Module 3) is also excluded.
        expect(defaultPeerFieldsForActual('Module3_Current_A')).not.toContain('Module5_Current_A');
        expect(defaultPeerFieldsForActual('Module3_Current_A')).toContain('Module4_Current_A');
    });

    it('labels Module 3 actual series from panel title', () => {
        const panel = {
            title: 'Module 3 Current — vs. Peer Band (Modules 1–4,6–8 Avg ± 2σ)',
            targets: build61Panel.targets,
        };
        const { panel: fixed } = applyModule5PeerBandFluxFixes(panel, { force: true });
        const targets = fixed.targets as { refId: string; query: string }[];
        expect(targets[0].query).toContain('_field: "Module 3 (Actual)"');
    });

    it('detects Module 3 peer-band panel by title', () => {
        expect(
            isPeerBandPanel({
                title: 'Module 3 Current — vs. Peer Band (Modules 1–4,6–8 Avg ± 2σ)',
                targets: [],
            })
        ).toBe(true);
    });

    it('infers Modules 1–7 peers for Module 8 panel title', () => {
        expect(
            inferPeerModuleNumbersFromPanel({
                title: 'Module 8 Current — vs. Peer Band (Modules 1–7 Avg ± 2σ)',
                targets: [],
            })
        ).toEqual([1, 2, 3, 4, 5, 6, 7]);
        expect(defaultPeerFieldsForActual('Module8_Current_A', [1, 2, 3, 4, 5, 6, 7])).toContain(
            'Module5_Current_A'
        );
        expect(defaultPeerFieldsForActual('Module8_Current_A', [1, 2, 3, 4, 5, 6, 7])).not.toContain(
            'Module8_Current_A'
        );
    });

    it('converts Prometheus Module 8 panel to Flux with correct peer fields and datasource', () => {
        const referenceTarget = {
            refId: 'A',
            datasource: { type: 'prometheus', uid: 'ffmk2neut49vkf' },
            query:
                'from(bucket: v.bucket)\n  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)\n  |> filter(fn: (r) =>\n    r.machine == "2406-176021" and\n    r._field == "Module5_Current_A"\n  )',
        };
        const referencePanel = {
            title: 'Module 5 Current — vs. Peer Band (Modules 1–4,6–8 Avg ± 2σ)',
            datasource: { type: 'prometheus', uid: 'ffmk2neut49vkf' },
            targets: [referenceTarget],
        };
        const module8PromPanel = {
            title: 'Module 8 Current — vs. Peer Band (Modules 1–7 Avg ± 2σ)',
            datasource: { type: 'prometheus', uid: 'prom-uid' },
            targets: [
                {
                    refId: 'A',
                    expr: 'machine_metrics{machine="2406-176021",field="Module8_Current_A"}',
                    legendFormat: 'Module 8 (Actual)',
                    datasource: { type: 'prometheus', uid: 'prom-uid' },
                },
                {
                    refId: 'B',
                    expr: 'avg(machine_metrics{machine="2406-176021",field=~"Module[1-7]_Current_A"})',
                    legendFormat: 'Peer Avg',
                },
                {
                    refId: 'C',
                    expr: 'avg(machine_metrics{machine="2406-176021",field=~"Module[1-7]_Current_A"}) + 2*stddev(machine_metrics{machine="2406-176021",field=~"Module[1-7]_Current_A"})',
                    legendFormat: 'Upper Band',
                },
                {
                    refId: 'D',
                    expr: 'avg(machine_metrics{machine="2406-176021",field=~"Module[1-7]_Current_A"}) - 2*stddev(machine_metrics{machine="2406-176021",field=~"Module[1-7]_Current_A"})',
                    legendFormat: 'Lower Band',
                },
            ],
        };
        expect(panelUsesPrometheusPeerBandQueries(module8PromPanel)).toBe(true);
        const { panel, changed, targetsFixed } = applyModule5PeerBandFluxFixes(module8PromPanel, {
            force: true,
            dashboardTitle: '2406-176021 / Exsolve',
            referenceTarget,
            referencePanel,
        });
        expect(changed).toBe(true);
        expect(targetsFixed).toBe(4);
        const targets = panel.targets as { refId: string; expr: string; datasource: { uid: string } }[];
        expect(targets[0].expr).toContain('from(bucket: v.bucket)');
        expect(targets[0].expr).toContain('Module8_Current_A');
        expect(targets[1].expr).toContain('Module5_Current_A');
        expect(targets[1].expr).toContain('Module7_Current_A');
        expect(targets[1].expr).not.toContain('Module8_Current_A');
        expect(targets[0].datasource.uid).toBe('ffmk2neut49vkf');
        expect(panelUsesPrometheusPeerBandQueries(panel)).toBe(false);
    });

    const historyComparisonPanel = {
        id: 415,
        title: 'Module 1 Current — History Comparison',
        targets: [
            {
                refId: 'A',
                expr: 'machine_metrics{machine="2406-176021",field="Module1_Current_A"}',
                legendFormat: 'Module 1 (Actual)',
            },
            {
                refId: 'B',
                expr: 'last_over_time(machine_metric_upper_bound{machine="2406-176021",field="Module1_Current_A"}[6m])',
                legendFormat: 'Upper Band',
            },
            {
                refId: 'C',
                expr: 'last_over_time(machine_metric_lower_bound{machine="2406-176021",field="Module1_Current_A"}[6m])',
                legendFormat: 'Lower Band',
            },
            {
                refId: 'D',
                expr: 'last_over_time(machine_metric_expected{machine="2406-176021",field="Module1_Current_A"}[6m])',
                legendFormat: 'Expected',
            },
        ],
    };

    it('excludes History Comparison panels from peer-band detection and Prom conversion', () => {
        expect(isHistoryComparisonPanel(historyComparisonPanel)).toBe(true);
        expect(isPeerBandPanel(historyComparisonPanel)).toBe(false);
        expect(panelUsesPrometheusPeerBandQueries(historyComparisonPanel)).toBe(false);
    });

    it('does not rewrite History Comparison panel queries', () => {
        const { panel, changed, targetsFixed } = applyModule5PeerBandFluxFixes(historyComparisonPanel, {
            force: true,
        });
        expect(changed).toBe(false);
        expect(targetsFixed).toBe(0);
        const targets = panel.targets as { refId: string; expr: string }[];
        expect(targets[0].expr).toContain('machine_metrics{');
        expect(targets[1].expr).toContain('machine_metric_upper_bound');
    });
});
