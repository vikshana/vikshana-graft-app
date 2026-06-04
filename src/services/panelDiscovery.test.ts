import {
    findFluxBrokenPanels,
    listDashboardPanels,
    panelHasBrokenFluxSyntax,
    resolvePanelForScopedFix,
} from './panelDiscovery';

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
