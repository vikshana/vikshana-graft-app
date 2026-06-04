import {
    isPanelAppendOperation,
    shouldChunkFullDashboard,
    shouldChunkUpdateDashboardArgs,
    topLevelPanelSlotCount,
} from './dashboardChunkedUpdate';

describe('shouldChunkFullDashboard', () => {
    it('does not chunk when panel count is at or below default chunk size', () => {
        const panels = Array.from({ length: 6 }, (_, i) => ({ id: i }));
        expect(shouldChunkFullDashboard({ panels })).toBe(false);
    });

    it('chunks when more than 6 top-level panel slots', () => {
        const panels = Array.from({ length: 7 }, (_, i) => ({ id: i }));
        expect(shouldChunkFullDashboard({ panels })).toBe(true);
        expect(topLevelPanelSlotCount({ panels })).toBe(7);
    });
});

describe('shouldChunkUpdateDashboardArgs', () => {
    it('detects large full-dashboard JSON from the LLM', () => {
        const panels = Array.from({ length: 12 }, (_, i) => ({ id: i }));
        expect(
            shouldChunkUpdateDashboardArgs({
                dashboard: { title: 'Test', panels },
                overwrite: true,
            })
        ).toBe(true);
    });

    it('detects many panel-append patch operations', () => {
        const operations = Array.from({ length: 10 }, (_, i) => ({
            op: 'add',
            path: '$.panels/-',
            value: { id: i },
        }));
        expect(
            shouldChunkUpdateDashboardArgs({
                uid: 'abc123',
                operations,
            })
        ).toBe(true);
    });

    it('does not chunk small patch updates', () => {
        expect(
            shouldChunkUpdateDashboardArgs({
                uid: 'abc123',
                operations: [{ op: 'replace', path: '$.title', value: 'New title' }],
            })
        ).toBe(false);
    });
});

describe('isPanelAppendOperation', () => {
    it('matches Grafana MCP append paths', () => {
        expect(isPanelAppendOperation({ op: 'add', path: '$.panels/-' })).toBe(true);
        expect(isPanelAppendOperation({ op: 'add', path: '$.panels/- ' })).toBe(true);
        expect(isPanelAppendOperation({ op: 'replace', path: '$.title' })).toBe(false);
    });
});
