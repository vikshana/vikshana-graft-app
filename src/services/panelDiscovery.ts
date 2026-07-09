type PanelRecord = Record<string, unknown>;

import {
    isHistoryComparisonPanel,
    isPeerBandPanel,
    panelTitleMatchesPeerBandMarker,
    PEER_BAND_TITLE_MARKER,
} from './fluxPeerBandFix';

export interface DashboardPanelEntry {
    panel: PanelRecord;
    /** Top-level index in `dashboard.panels` (Grafana arrayIndex). */
    arrayIndex: number;
    panelId: number | undefined;
    title: string;
    path: number[];
}

/** Flatten panels; arrayIndex is the top-level `dashboard.panels` slot (Grafana table column). */
export function listDashboardPanels(panels: unknown): DashboardPanelEntry[] {
    if (!Array.isArray(panels)) {
        return [];
    }
    const out: DashboardPanelEntry[] = [];
    for (let i = 0; i < panels.length; i++) {
        const item = panels[i];
        if (!item || typeof item !== 'object') {
            continue;
        }
        const panel = item as PanelRecord;
        const type = typeof panel.type === 'string' ? panel.type : '';
        if (type === 'row' && Array.isArray(panel.panels)) {
            for (let j = 0; j < panel.panels.length; j++) {
                collectPanels(panel.panels[j], [i, j], i, out);
            }
        } else {
            collectPanels(item, [i], i, out);
        }
    }
    return out;
}

function collectPanels(
    item: unknown,
    path: number[],
    arrayIndex: number,
    out: DashboardPanelEntry[]
): void {
    if (!item || typeof item !== 'object') {
        return;
    }
    const panel = item as PanelRecord;
    const title = typeof panel.title === 'string' ? panel.title.trim() : '';
    const panelId = typeof panel.id === 'number' ? panel.id : undefined;
    if (panelId != null || title) {
        out.push({ panel, arrayIndex, panelId, title, path });
    }
    const nested = panel.panels;
    if (Array.isArray(nested)) {
        for (let j = 0; j < nested.length; j++) {
            collectPanels(nested[j], [...path, j], arrayIndex, out);
        }
    }
}

function normalizeTitle(title: string): string {
    return title.trim().toLowerCase();
}

/** Normalize panel titles for rename / exact lookup (trim quotes, collapse whitespace). */
export function normalizePanelTitleForMatch(title: string): string {
    return title
        .trim()
        .replace(/^["']|["']$/g, '')
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

/** Exact title match only — avoids renaming "Pressure" when user asked for "Pressure Gauge". */
export function findPanelByStrictTitle(
    entries: DashboardPanelEntry[],
    title: string
): DashboardPanelEntry | undefined {
    const want = normalizePanelTitleForMatch(title);
    if (!want) {
        return undefined;
    }
    return entries.find((e) => normalizePanelTitleForMatch(e.title) === want);
}

const DATA_PANEL_TYPES = new Set(['timeseries', 'gauge', 'stat', 'barchart', 'table', 'heatmap', 'logs']);

/**
 * Rename lookup: exact title match, but when a row header and a data panel share the same
 * title (e.g. "Levels"), prefer the data panel the operator actually charts.
 */
export function findPanelForRename(
    entries: DashboardPanelEntry[],
    title: string
): DashboardPanelEntry | undefined {
    const want = normalizePanelTitleForMatch(title);
    if (!want) {
        return undefined;
    }
    const matches = entries.filter((e) => normalizePanelTitleForMatch(e.title) === want);
    if (matches.length === 0) {
        return undefined;
    }
    if (matches.length === 1) {
        return matches[0];
    }
    const nonRows = matches.filter((e) => String(e.panel.type ?? '').toLowerCase() !== 'row');
    const pool = nonRows.length > 0 ? nonRows : matches;
    const dataPanels = pool.filter((e) => DATA_PANEL_TYPES.has(String(e.panel.type ?? '').toLowerCase()));
    if (dataPanels.length === 1) {
        return dataPanels[0];
    }
    if (dataPanels.length > 1) {
        return dataPanels[0];
    }
    return pool[0];
}

function stripPanelWordSuffix(title: string): string {
    return title.replace(/\s+panel\s*$/i, '').trim();
}

/**
 * Panel lookup for remove/delete — exact match first, then prefix match when the user
 * omits words (e.g. "Cartridge Happiness Panel" → "Cartridge Happiness Score").
 */
export function findPanelForRemoval(
    entries: DashboardPanelEntry[],
    title: string
): DashboardPanelEntry | undefined {
    const strict = findPanelByStrictTitle(entries, title);
    if (strict) {
        return strict;
    }

    const core = normalizePanelTitleForMatch(stripPanelWordSuffix(title));
    if (!core) {
        return undefined;
    }

    const candidates = entries.filter((e) => {
        const have = normalizePanelTitleForMatch(e.title);
        return have === core || have.startsWith(`${core} `) || have.startsWith(core);
    });

    if (candidates.length === 1) {
        return candidates[0];
    }
    if (candidates.length > 1) {
        return [...candidates].sort(
            (a, b) =>
                Math.abs(a.title.length - title.length) - Math.abs(b.title.length - title.length)
        )[0];
    }
    return undefined;
}

/** Resolve a panel node from dashboard.panels tree by listDashboardPanels path indices. */
export function getPanelAtPath(rootPanels: unknown[], path: number[]): PanelRecord | undefined {
    if (!Array.isArray(rootPanels) || path.length === 0) {
        return undefined;
    }
    let current: unknown[] = rootPanels;
    for (let i = 0; i < path.length; i++) {
        const node = current[path[i]];
        if (!node || typeof node !== 'object') {
            return undefined;
        }
        if (i === path.length - 1) {
            return node as PanelRecord;
        }
        const nested = (node as PanelRecord).panels;
        if (!Array.isArray(nested)) {
            return undefined;
        }
        current = nested;
    }
    return undefined;
}

/** Remove a panel from dashboard.panels tree by listDashboardPanels path indices. */
export function removePanelAtPath(rootPanels: unknown[], path: number[]): boolean {
    if (!Array.isArray(rootPanels) || path.length === 0) {
        return false;
    }
    let current: unknown[] = rootPanels;
    for (let i = 0; i < path.length - 1; i++) {
        const node = current[path[i]] as PanelRecord | undefined;
        if (!node?.panels || !Array.isArray(node.panels)) {
            return false;
        }
        current = node.panels;
    }
    const index = path[path.length - 1];
    if (index < 0 || index >= current.length) {
        return false;
    }
    current.splice(index, 1);
    return true;
}

function titleMatches(want: string, have: string): boolean {
    const w = normalizeTitle(want);
    const h = normalizeTitle(have);
    if (!w || !h) {
        return false;
    }
    return h === w || h.includes(w) || w.includes(h);
}

/** Query text contains common broken Flux tokens from anomaly-band panels. */
export function panelHasBrokenFluxSyntax(panel: PanelRecord): boolean {
    const blob = JSON.stringify(panel);
    return (
        /\bstdDev\b/.test(blob) ||
        /\bmean_val\b/.test(blob) ||
        /\bgroup\s*\(\s*by\s*:/i.test(blob) ||
        /\|\>\s*group\s*\(\s*by\b/i.test(blob) ||
        /\|\>\s*reduce\s*\([^)]*\bfn\s*:\s*\(\s*acc\s*,/is.test(blob)
    );
}

export function findPanelById(entries: DashboardPanelEntry[], panelId: number): DashboardPanelEntry | undefined {
    return entries.find((e) => e.panelId === panelId);
}

export function findPanelByArrayIndex(
    entries: DashboardPanelEntry[],
    arrayIndex: number
): DashboardPanelEntry | undefined {
    return entries.find((e) => e.arrayIndex === arrayIndex);
}

export function findPanelByTitle(
    entries: DashboardPanelEntry[],
    titleHint: string
): DashboardPanelEntry | undefined {
    const exact = entries.find((e) => titleMatches(titleHint, e.title));
    if (exact) {
        return exact;
    }
    const words = titleHint
        .toLowerCase()
        .split(/[^\w]+/)
        .filter((w) => w.length > 3);
    if (words.length === 0) {
        return undefined;
    }
    let best: DashboardPanelEntry | undefined;
    let bestScore = 0;
    for (const e of entries) {
        const t = e.title.toLowerCase();
        const score = words.filter((w) => t.includes(w)).length;
        if (score > bestScore) {
            bestScore = score;
            best = e;
        }
    }
    return bestScore >= 2 ? best : undefined;
}

export function findModule5PeerBandPanel(entries: DashboardPanelEntry[]): DashboardPanelEntry | undefined {
    return findPeerBandPanels(entries)[0];
}

export function findPeerBandPanels(
    entries: DashboardPanelEntry[],
    titleContains = PEER_BAND_TITLE_MARKER
): DashboardPanelEntry[] {
    return entries.filter(
        (e) =>
            !isHistoryComparisonPanel(e.panel) &&
            (panelTitleMatchesPeerBandMarker(e.title, titleContains) ||
                panelTitleMatchesPeerBandMarker(
                    typeof e.panel.description === 'string' ? e.panel.description : '',
                    titleContains
                ))
    );
}

export function isModule5PeerBandPanel(panel: PanelRecord): boolean {
    return isPeerBandPanel(panel);
}

export interface ResolvedPanelTarget {
    entry: DashboardPanelEntry;
    warning?: string;
}

/**
 * Pick the panel to fix. Prefers title/arrayIndex over a mismatched panelId.
 */
export function resolvePanelForScopedFix(
    dashboard: Record<string, unknown>,
    scope: {
        panelId?: number;
        panelTitle?: string;
        panelArrayIndex?: number;
    }
): { ok: true; resolved: ResolvedPanelTarget } | { ok: false; error: string; suggestions?: string[] } {
    const entries = listDashboardPanels(dashboard.panels);
    if (entries.length === 0) {
        return { ok: false, error: 'Dashboard has no panels.' };
    }

    if (scope.panelTitle) {
        const byTitle = findPanelByTitle(entries, scope.panelTitle);
        if (byTitle) {
            if (scope.panelId != null && byTitle.panelId !== scope.panelId) {
                return {
                    ok: true,
                    resolved: {
                        entry: byTitle,
                        warning:
                            `Panel id **${scope.panelId}** is **${findPanelById(entries, scope.panelId)?.title ?? 'another panel'}**, ` +
                            `not **${byTitle.title}**. Graft is fixing **${byTitle.title}** (panel id **${byTitle.panelId ?? '?'}**, index **${byTitle.arrayIndex}**).`,
                    },
                };
            }
            return { ok: true, resolved: { entry: byTitle } };
        }
    }

    if (scope.panelArrayIndex != null) {
        const byIndex = findPanelByArrayIndex(entries, scope.panelArrayIndex);
        if (byIndex) {
            return { ok: true, resolved: { entry: byIndex } };
        }
        return {
            ok: false,
            error: `No panel at array index **${scope.panelArrayIndex}** on this dashboard.`,
            suggestions: suggestSimilarPanels(entries, scope),
        };
    }

    if (scope.panelId != null) {
        const byId = findPanelById(entries, scope.panelId);
        if (!byId) {
            return {
                ok: false,
                error: `No panel with panel id **${scope.panelId}** on this dashboard.`,
                suggestions: suggestSimilarPanels(entries, scope),
            };
        }

        if (scope.panelTitle && !titleMatches(scope.panelTitle, byId.title)) {
            const byTitle = findPanelByTitle(entries, scope.panelTitle);
            if (byTitle) {
                return {
                    ok: true,
                    resolved: {
                        entry: byTitle,
                        warning:
                            `Panel id **${scope.panelId}** is **${byId.title}**, not **${scope.panelTitle}**. ` +
                            `Graft is fixing **${byTitle.title}** (panel id **${byTitle.panelId ?? '?'}**).`,
                    },
                };
            }
        }

        const fluxBroken = findFluxBrokenPanels(entries);
        const modulePeer = findModule5PeerBandPanel(entries);

        if (
            modulePeer &&
            modulePeer.panelId !== byId.panelId &&
            panelHasBrokenFluxSyntax(modulePeer.panel)
        ) {
            return {
                ok: true,
                resolved: {
                    entry: modulePeer,
                    warning:
                        `Panel id **${scope.panelId}** is **${byId.title || '(untitled)'}**, not the Module 5 peer-band panel. ` +
                        `Graft is fixing **${modulePeer.title}** (panel id **${modulePeer.panelId ?? '?'}**, index **${modulePeer.arrayIndex}**).`,
                },
            };
        }

        if (
            fluxBroken.length > 0 &&
            !panelHasBrokenFluxSyntax(byId.panel) &&
            fluxBroken.some((e) => e.panelId !== byId.panelId)
        ) {
            const broken = fluxBroken.find((e) => e.panelId !== byId.panelId);
            if (broken) {
                return {
                    ok: true,
                    resolved: {
                        entry: broken,
                        warning:
                            `Panel id **${scope.panelId}** is **${byId.title}**. ` +
                            `Graft is fixing **${broken.title}** (panel id **${broken.panelId ?? '?'}**, index **${broken.arrayIndex}**) which has broken Flux.`,
                    },
                };
            }
        }

        return { ok: true, resolved: { entry: byId } };
    }

    return { ok: false, error: 'No panel id, index, or title in scope.' };
}

export function findFluxBrokenPanels(entries: DashboardPanelEntry[]): DashboardPanelEntry[] {
    return entries.filter((e) => panelHasBrokenFluxSyntax(e.panel));
}

function suggestSimilarPanels(
    entries: DashboardPanelEntry[],
    scope: { panelTitle?: string; panelId?: number }
): string[] {
    const hints: string[] = [];
    if (scope.panelTitle) {
        const t = findPanelByTitle(entries, scope.panelTitle);
        if (t) {
            hints.push(
                `**${t.title}** — panel id **${t.panelId ?? '?'}**, array index **${t.arrayIndex}**`
            );
        }
    }
    for (const e of findFluxBrokenPanels(entries).slice(0, 5)) {
        hints.push(
            `**${e.title || '(no title)'}** — panel id **${e.panelId ?? '?'}**, array index **${e.arrayIndex}** (has broken Flux)`
        );
    }
    return hints;
}

export function formatPanelTargetLabel(entry: DashboardPanelEntry): string {
    const idPart = entry.panelId != null ? `panel id **${entry.panelId}**` : 'panel';
    const titlePart = entry.title ? `**${entry.title}**` : '(no title)';
    return `${titlePart} (${idPart}, index **${entry.arrayIndex}**)`;
}
