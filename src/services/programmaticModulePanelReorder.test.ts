import {
    computeModulePanelGridPositions,
    computeModulePanelSectionStartY,
} from './programmaticModulePanelReorder';
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

function otherPanel(id: number, title: string, y: number, h: number): DashboardPanelEntry {
    return {
        panelId: id,
        title,
        arrayIndex: id,
        path: [id],
        panel: { id, title, gridPos: { x: 0, y, w: 12, h } },
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

    it('keeps historical history comparison when peer-RF excluded', () => {
        const entries = [
            entry(501, 'Module 5 Current — History Comparison', 280),
            entry(502, 'Module 5 Current — RandomForest ML (Influx)', 300),
            entry(503, 'Module 5 Current — vs. Peer Band', 292),
            entry(504, 'Module 5 Current — RandomForest vs Peers (Influx)', 304),
        ];
        const placements = computeModulePanelGridPositions(entries, false, 280);
        expect(placements.map((p) => p.entry.title)).toEqual([
            'Module 5 Current — History Comparison',
            'Module 5 Current — RandomForest ML (Influx)',
            'Module 5 Current — vs. Peer Band',
        ]);
    });

    it('orders Module 5 block: live history → historical → peer band → peer-RF', () => {
        const entries = [
            entry(504, 'Module 5 Current — RandomForest vs Peers (Influx)', 320),
            entry(503, 'Module 5 Current — vs. Peer Band', 308),
            entry(502, 'Module 5 Current — RandomForest ML (Influx)', 296),
            entry(501, 'Module 5 Current — History Comparison', 284),
        ];
        const placements = computeModulePanelGridPositions(entries, true, 284);
        expect(placements.map((p) => p.entry.title)).toEqual([
            'Module 5 Current — History Comparison',
            'Module 5 Current — RandomForest ML (Influx)',
            'Module 5 Current — vs. Peer Band',
            'Module 5 Current — RandomForest vs Peers (Influx)',
        ]);
    });

    it('starts module block below non-module panels when startY omitted', () => {
        const entries = [
            otherPanel(115, 'Pressure', 0, 6),
            otherPanel(128, 'Overview', 27, 14),
            entry(101, 'Module 1 Current — History Comparison', 0),
            entry(201, 'Module 2 Current — History Comparison', 120),
        ];
        expect(computeModulePanelSectionStartY(entries, true)).toBe(41);
        const placements = computeModulePanelGridPositions(entries, true);
        expect(placements[0].gridPos).toEqual({ x: 0, y: 41, w: 24, h: 12 });
        expect(placements[1].gridPos.y).toBe(53);
    });
});
