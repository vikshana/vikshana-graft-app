import {
    findFluxBrokenPanels,
    findPanelByStrictTitle,
    findPanelForGrafanaAlert,
    findPanelForRemoval,
    listDashboardPanels,
    listDashboardPanelsFromDashboard,
    normalizePanelTitleForMatch,
    panelHasBrokenFluxSyntax,
    removePanelAtPath,
    resolvePanelForScopedFix,
} from './panelDiscovery';

describe('findPanelByStrictTitle', () => {
    const entries = listDashboardPanels([
        { id: 1, title: 'Pressure', type: 'gauge' },
        { id: 2, title: 'Pressure Gauge', type: 'gauge' },
        { id: 3, title: 'Pressure Monitoring', type: 'timeseries' },
    ]);

    it('matches exact title case-insensitively', () => {
        const hit = findPanelByStrictTitle(entries, 'pressure gauge');
        expect(hit?.panelId).toBe(2);
        expect(hit?.title).toBe('Pressure Gauge');
    });

    it('does not match shorter title when query is longer', () => {
        expect(findPanelByStrictTitle(entries, 'Pressure Gauge')?.panelId).toBe(2);
        expect(findPanelByStrictTitle(entries, 'Pressure')?.panelId).toBe(1);
    });

    it('does not fuzzy-match Pressure Monitoring for Pressure Gauge', () => {
        expect(findPanelByStrictTitle(entries, 'Pressure Gauge')?.title).toBe('Pressure Gauge');
        expect(findPanelByStrictTitle(entries, 'Pressure Monitoring')?.panelId).toBe(3);
    });

    it('strips surrounding quotes when matching', () => {
        expect(normalizePanelTitleForMatch('"Pressure Gauge"')).toBe('pressure gauge');
        expect(findPanelByStrictTitle(entries, '"Pressure Gauge"')?.panelId).toBe(2);
    });
});

describe('findPanelForRemoval', () => {
    it('maps shortened remove query to full panel title', () => {
        const entries = listDashboardPanels([
            { id: 1, title: 'Cartridge Happiness Score', type: 'gauge' },
        ]);
        expect(findPanelForRemoval(entries, 'Cartridge Happiness Panel')?.title).toBe(
            'Cartridge Happiness Score'
        );
    });

    it('maps RandomForest vs Peers to the (Influx) panel title', () => {
        const entries = listDashboardPanels([
            { id: 9, title: 'Module 2 Current — RandomForest vs Peers (Influx)', type: 'timeseries' },
        ]);
        expect(findPanelForRemoval(entries, 'Module 2 Current — RandomForest vs Peers')?.panelId).toBe(9);
        expect(findPanelForGrafanaAlert(entries, 'Module 2 Current — RandomForest vs Peers')?.panelId).toBe(9);
    });

    it('resolves library-panel name when title is empty', () => {
        const entries = listDashboardPanelsFromDashboard({
            panels: [
                {
                    id: 12,
                    type: 'timeseries',
                    title: '',
                    libraryPanel: { name: 'Module 2 Current — RandomForest vs Peers (Influx)', uid: 'lib1' },
                },
            ],
        });
        expect(findPanelForGrafanaAlert(entries, 'Module 2 Current — RandomForest vs Peers')?.panelId).toBe(12);
    });

    it('does not bind a RandomForest vs Peers alert to Own History via word overlap', () => {
        const entries = listDashboardPanels([
            { id: 1, title: 'Module 2 Current — Alert Test Own History ±2σ', type: 'timeseries' },
            { id: 9, title: 'Module 2 Current — RandomForest vs Peers (Influx)', type: 'timeseries' },
        ]);
        expect(findPanelForGrafanaAlert(entries, 'Module 2 Current — RandomForest vs Peers')?.panelId).toBe(9);
        const onlyHistory = listDashboardPanels([
            { id: 1, title: 'Module 2 Current — Alert Test Own History ±2σ', type: 'timeseries' },
        ]);
        expect(findPanelForGrafanaAlert(onlyHistory, 'Module 2 Current — RandomForest vs Peers')).toBeUndefined();
    });
});

describe('removePanelAtPath', () => {
    it('splices top-level panel', () => {
        const panels = [
            { id: 1, title: 'A' },
            { id: 2, title: 'B' },
        ];
        expect(removePanelAtPath(panels, [0])).toBe(true);
        expect(panels).toHaveLength(1);
        expect((panels[0] as { title: string }).title).toBe('B');
    });
});

describe('resolvePanelForScopedFix', () => {
    const dashboard = {
        panels: [
            { id: 10, title: 'Pressure1', targets: [{ query: 'from() |> filter(fn: (r) => r._field == "Pressure1_psi")' }] },
            { id: 35, title: 'Metal', targets: [{ expr: 'up' }] },
            {
                id: 424,
                title: 'Module 5 Current — vs. Peer Band (Modules 1–4,6–8 Avg ± 2σ)',
                targets: [
                    { refId: 'A', query: 'from() |> filter(fn: (r) => r._field == "current")' },
                    {
                        refId: 'B',
                        query: 'from() |> group(by: ["x"]) |> stdDev() |> mean_val',
                    },
                    { refId: 'C', query: 'from() |> group(by: ["x"]) |> stdDev()' },
                    { refId: 'D', query: 'from() |> group(by: ["x"]) |> stdDev()' },
                ],
            },
        ],
    };

    it('redirects panel id 35 to Module 5 when id 35 is not the broken flux panel', () => {
        const r = resolvePanelForScopedFix(dashboard, {
            panelId: 35,
            panelTitle: undefined,
        });
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.resolved.entry.title).toContain('Module 5');
            expect(r.resolved.warning).toMatch(/Panel id \*\*35\*\*/);
        }
    });

    it('prefers panel title over mismatched panel id', () => {
        const r = resolvePanelForScopedFix(dashboard, {
            panelId: 35,
            panelTitle: 'Module 5 Current',
        });
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.resolved.entry.panelId).toBe(424);
        }
    });

    it('finds broken flux panels', () => {
        const entries = listDashboardPanels(dashboard.panels);
        const broken = findFluxBrokenPanels(entries);
        expect(broken).toHaveLength(1);
        expect(panelHasBrokenFluxSyntax(broken[0].panel)).toBe(true);
    });
});
