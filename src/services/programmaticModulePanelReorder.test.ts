import { computeModulePanelGridPositions } from './programmaticModulePanelReorder';
import type { DashboardPanelEntry } from './panelDiscovery';

function entry(id: number, title: string, y: number): DashboardPanelEntry {
    return {
        panelId: id,
        title,
        arrayIndex: id,
        path: [id],
        panel: { id, title, gridPos: { x: 0, y, w: 24, h: 12 } },
    };
}

describe('computeModulePanelGridPositions', () => {
    it('orders modules 1 then 2 with uniform grid', () => {
        const entries = [
            entry(801, 'Module 8 Current — History Comparison', 100),
            entry(101, 'Module 1 Current — History Comparison', 200),
            entry(802, 'Module 8 Current — vs. Peer Band', 112),
            entry(102, 'Module 1 Current — vs. Peer Band', 212),
        ];
        const placements = computeModulePanelGridPositions(entries, true, 100);
        expect(placements.map((p) => p.entry.title)).toEqual([
            'Module 1 Current — History Comparison',
            'Module 1 Current — vs. Peer Band',
            'Module 8 Current — History Comparison',
            'Module 8 Current — vs. Peer Band',
        ]);
        expect(placements[0].gridPos).toEqual({ x: 0, y: 100, w: 24, h: 12 });
        expect(placements[2].gridPos.y).toBe(124);
    });

    it('excludes RandomForest when requested', () => {
        const entries = [
            entry(5, 'Module 5 Current — RandomForest ML (Influx)', 300),
            entry(5, 'Module 5 Current — vs. Peer Band', 280),
        ];
        const placements = computeModulePanelGridPositions(entries, false, 280);
        expect(placements).toHaveLength(1);
        expect(placements[0].entry.title).toContain('Peer Band');
    });
});
