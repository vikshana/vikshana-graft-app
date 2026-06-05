/** Live PromQL History Comparison (recent ~35d window). */
export function isLiveHistoryComparisonPanel(title: string): boolean {
    return /History Comparison/i.test(title) && !isHistoricalHistoryComparisonPanel(title);
}

/** Influx backfill for History Comparison — same meaning as live panel, older dates. */
export function isHistoricalHistoryComparisonPanel(title: string): boolean {
    return (
        /History Comparison\s*\(\s*historical/i.test(title) ||
        /RandomForest ML\s*\(\s*Influx\s*\)/i.test(title)
    );
}

export function isModuleHistoryComparisonPanel(title: string): boolean {
    return isLiveHistoryComparisonPanel(title) || isHistoricalHistoryComparisonPanel(title);
}

export function isPeerRandomForestPanel(title: string): boolean {
    return /RandomForest\s+vs\s+Peers/i.test(title);
}

/** Rename legacy "RandomForest ML (Influx)" to operator-facing History Comparison label. */
export function canonicalHistoricalHistoryComparisonTitle(moduleNumber: number): string {
    return `Module ${moduleNumber} Current — History Comparison (historical / Influx)`;
}

export function normalizeLegacyModulePanelTitle(title: string): string {
    const m = title.match(/^Module\s*(\d+)\s+Current\b/i);
    if (!m?.[1]) {
        return title;
    }
    const n = parseInt(m[1], 10);
    if (!Number.isFinite(n)) {
        return title;
    }
    if (isHistoricalHistoryComparisonPanel(title) && !/History Comparison\s*\(\s*historical/i.test(title)) {
        return canonicalHistoricalHistoryComparisonTitle(n);
    }
    return title;
}

/** Order panels within a module block: live history → historical history → peer band → peer-RF. */
export function modulePanelSortKey(title: string): number {
    if (isLiveHistoryComparisonPanel(title)) {
        return 0;
    }
    if (isHistoricalHistoryComparisonPanel(title)) {
        return 1;
    }
    if (/vs\.\s*Peer\s*Band/i.test(title) || /\bPeer\s*Band\b/i.test(title)) {
        return 2;
    }
    if (isPeerRandomForestPanel(title)) {
        return 3;
    }
    if (/RandomForest/i.test(title)) {
        return 1;
    }
    return 9;
}
