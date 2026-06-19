import {
    canonicalHistoricalHistoryComparisonTitle,
    isHistoricalHistoryComparisonPanel,
    modulePanelSortKey,
    normalizeLegacyModulePanelTitle,
} from './modulePanelTitles';

describe('modulePanelTitles', () => {
    it('treats RandomForest ML (Influx) as historical history comparison', () => {
        const legacy = 'Module 5 Current — RandomForest ML (Influx)';
        expect(isHistoricalHistoryComparisonPanel(legacy)).toBe(true);
        expect(normalizeLegacyModulePanelTitle(legacy)).toBe(
            canonicalHistoricalHistoryComparisonTitle(5)
        );
    });

    it('sorts live history before historical before peer band before peer-RF', () => {
        expect(modulePanelSortKey('Module 5 Current — History Comparison')).toBe(0);
        expect(modulePanelSortKey('Module 5 Current — RandomForest ML (Influx)')).toBe(1);
        expect(modulePanelSortKey('Module 5 Current — History Comparison (historical / Influx)')).toBe(
            1
        );
        // Own-history (vs. Own History ± 2σ) occupies sort key 2, so peer band and
        // peer-RF shift to 3 and 4 while preserving the documented relative order.
        expect(modulePanelSortKey('Module 5 Current — vs. Own History (± 2σ)')).toBe(2);
        expect(modulePanelSortKey('Module 5 Current — vs. Peer Band (Modules 1–4,6–8 Avg ± 2σ)')).toBe(
            3
        );
        expect(modulePanelSortKey('Module 5 Current — RandomForest vs Peers (Influx)')).toBe(4);
    });
});
