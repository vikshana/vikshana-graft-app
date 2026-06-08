import { applyDashboardTitleRow, panelLooksLikeDashboardTitleRow } from './dashboardTitleRowLayout';
import { MODULE_CURRENT_TITLE_RE } from './modulePanelReorderParse';
import {
    computeModulePanelSectionStartY,
    MODULE_PANEL_GRID,
    selectModuleCurrentPanels,
} from './programmaticModulePanelReorder';
import { listDashboardPanels, type DashboardPanelEntry } from './panelDiscovery';
import { parseModuleNumberFromTitle } from './modulePanelReorderParse';
import { isPeerRandomForestPanel, modulePanelSortKey, normalizeLegacyModulePanelTitle } from './modulePanelTitles';

type PanelRecord = Record<string, unknown>;

export interface ApplyBestPracticeLayoutResult {
    panels: PanelRecord[];
    titleLabel?: string;
    repositionedPanels: number;
    isModuleDashboard: boolean;
}

function asGrid(panel: PanelRecord): { x: number; y: number; w: number; h: number } {
    const gp = (panel.gridPos ?? {}) as Record<string, number>;
    return {
        x: typeof gp.x === 'number' ? gp.x : 0,
        y: typeof gp.y === 'number' ? gp.y : 0,
        w: typeof gp.w === 'number' ? gp.w : 24,
        h: typeof gp.h === 'number' ? gp.h : 8,
    };
}

function setGrid(panel: PanelRecord, grid: { x: number; y: number; w: number; h: number }): void {
    panel.gridPos = grid;
}

function inferTitleLabel(dashboardTitle?: string): string | undefined {
    if (!dashboardTitle) {
        return undefined;
    }
    const slash = dashboardTitle.match(/\d{4}-\d+\s*\/\s*(.+)$/);
    return slash?.[1]?.trim();
}

function isKpiPanel(panel: PanelRecord): boolean {
    const type = String(panel.type ?? '');
    if (type === 'gauge' || type === 'barchart' || type === 'stat') {
        return true;
    }
    const title = String(panel.title ?? '').toLowerCase();
    return /\b(pressure|temperature|temp|flow|rate|score)\b/.test(title) && type !== 'timeseries';
}

function isOverviewPanel(panel: PanelRecord): boolean {
    const title = String(panel.title ?? '').toLowerCase();
    return title.includes('overview') || asGrid(panel).h >= 12;
}

function isTrendPanel(panel: PanelRecord): boolean {
    const title = String(panel.title ?? '').toLowerCase();
    return String(panel.type ?? '') === 'timeseries' && /\b(trend|history|over time)\b/.test(title);
}

function layoutInstrumentationPanels(panels: PanelRecord[]): { panels: PanelRecord[]; moved: number } {
    const rows = panels.filter((p) => p.type === 'row');
    const content = panels.filter((p) => p.type !== 'row' && !panelLooksLikeDashboardTitleRow(p));
    const titlePanels = panels.filter((p) => panelLooksLikeDashboardTitleRow(p));

    const kpis = content.filter(isKpiPanel);
    const overviews = content.filter((p) => !kpis.includes(p) && isOverviewPanel(p));
    const trends = content.filter((p) => !kpis.includes(p) && !overviews.includes(p) && isTrendPanel(p));
    const rest = content.filter((p) => !kpis.includes(p) && !overviews.includes(p) && !trends.includes(p));

    const ordered = [...titlePanels, ...kpis, ...trends, ...overviews, ...rest, ...rows];
    let y = 0;
    let moved = 0;
    let kpiSlot = 0;

    for (const panel of ordered) {
        const prev = asGrid(panel);
        if (panelLooksLikeDashboardTitleRow(panel)) {
            const next = { x: 0, y: 0, w: 24, h: 2 };
            if (prev.x !== next.x || prev.y !== next.y || prev.w !== next.w || prev.h !== next.h) {
                moved++;
            }
            setGrid(panel, next);
            y = 2;
            kpiSlot = 0;
            continue;
        }

        if (panel.type === 'row') {
            const next = { x: 0, y, w: 24, h: 1 };
            if (prev.y !== next.y || prev.x !== next.x) {
                moved++;
            }
            setGrid(panel, next);
            y += 1;
            continue;
        }

        if (kpis.includes(panel) && kpiSlot < 4) {
            const col = kpiSlot % 2;
            const rowOffset = Math.floor(kpiSlot / 2);
            const next = { x: col * 12, y: y + rowOffset * 8, w: 12, h: 8 };
            if (prev.x !== next.x || prev.y !== next.y || prev.w !== next.w || prev.h !== next.h) {
                moved++;
            }
            setGrid(panel, next);
            kpiSlot++;
            if (kpiSlot === kpis.length) {
                y = y + Math.ceil(kpis.length / 2) * 8;
            }
            continue;
        }

        const next = { x: 0, y, w: 24, h: Math.max(prev.h, 8) };
        if (prev.x !== next.x || prev.y !== next.y || prev.w !== next.w) {
            moved++;
        }
        setGrid(panel, next);
        y += next.h;
    }

    return { panels: ordered, moved };
}

function layoutModuleBlock(entries: DashboardPanelEntry[], includeRandomForest: boolean): number {
    const matched = selectModuleCurrentPanels(entries, includeRandomForest)
        .map((e) => e.panel as PanelRecord)
        .sort((a, b) => modulePanelSortKey(String(a.title ?? ''), String(b.title ?? '')));

    const startY = computeModulePanelSectionStartY(entries, includeRandomForest);
    let y = startY;
    let moved = 0;

    for (const panel of matched) {
        const prev = asGrid(panel);
        const title = String(panel.title ?? '');
        const mod = parseModuleNumberFromTitle(title);
        if (mod != null) {
            panel.title = normalizeLegacyModulePanelTitle(title, mod);
        }
        const next = { x: 0, y, w: MODULE_PANEL_GRID.w, h: MODULE_PANEL_GRID.h };
        if (prev.x !== next.x || prev.y !== next.y || prev.w !== next.w || prev.h !== next.h) {
            moved++;
        }
        setGrid(panel, next);
        y += MODULE_PANEL_GRID.h;
    }
    return moved;
}

/**
 * Reorganize an existing dashboard using PowerTech layout rules without deleting panel queries.
 * Module dashboards: instrumentation on top, Module N Current block at bottom.
 * Instrumentation dashboards (Keysight): title → KPIs → trends → overview → rows.
 */
export function applyBestPracticeDashboardLayout(
    panels: PanelRecord[],
    opts?: { dashboardTitle?: string; titleLabel?: string }
): ApplyBestPracticeLayoutResult {
    const entries = listDashboardPanels(panels);
    const hasModulePanels = entries.some((e) => MODULE_CURRENT_TITLE_RE.test(e.title));
    const titleLabel = opts?.titleLabel ?? inferTitleLabel(opts?.dashboardTitle);

    const titleApplied = titleLabel
        ? applyDashboardTitleRow(panels, titleLabel)
        : applyDashboardTitleRow(panels, inferTitleLabel(opts?.dashboardTitle) ?? 'Dashboard');

    let repositioned = titleApplied.shiftedPanels;
    const nonModule = titleApplied.panels.filter(
        (p) => !MODULE_CURRENT_TITLE_RE.test(String(p.title ?? ''))
    );
    const moduleOnly = titleApplied.panels.filter((p) =>
        MODULE_CURRENT_TITLE_RE.test(String(p.title ?? ''))
    );

    const instrument = layoutInstrumentationPanels(nonModule);
    let working = [...instrument.panels, ...moduleOnly];
    repositioned += instrument.moved;

    if (hasModulePanels) {
        repositioned += layoutModuleBlock(listDashboardPanels(working), true);
    }

    return {
        panels: working,
        titleLabel: titleLabel ?? undefined,
        repositionedPanels: repositioned,
        isModuleDashboard: hasModulePanels,
    };
}
