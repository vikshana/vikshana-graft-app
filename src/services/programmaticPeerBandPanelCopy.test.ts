import { inferMachineIdFromDashboardTitle } from './programmaticPeerBandPanelCopy';
import { findPeerBandPanels, listDashboardPanels } from './panelDiscovery';
import { PEER_BAND_TITLE_MARKER } from './fluxPeerBandFix';

describe('inferMachineIdFromDashboardTitle', () => {
    it('reads machine id before slash in dashboard title', () => {
        expect(inferMachineIdFromDashboardTitle('2406-176021 / Exsolve')).toBe('2406-176021');
        expect(inferMachineIdFromDashboardTitle('2505-200033 / GlenTest')).toBe('2505-200033');
    });
});

describe('findPeerBandPanels for copy title filter', () => {
    const panels = [
        {
            id: 1,
            title: 'Module 1 Current — vs. Peer Band (Modules 1–4,6–8 Avg ± 2σ)',
            targets: [],
        },
        {
            id: 2,
            title: 'Module 1 Current — History Comparison',
            targets: [
                {
                    expr: 'last_over_time(machine_metric_upper_bound{machine="x",field="Module1_Current_A"}[6m])',
                },
            ],
        },
    ];

    it('includes peer-band panels and excludes history comparison', () => {
        const entries = findPeerBandPanels(listDashboardPanels(panels), PEER_BAND_TITLE_MARKER);
        expect(entries).toHaveLength(1);
        expect(entries[0].title).toContain('vs. Peer Band');
    });
});
