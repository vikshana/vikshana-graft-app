type PanelRecord = Record<string, unknown>;

export const DASHBOARD_TITLE_ROW_HEIGHT = 2;
export const DASHBOARD_TITLE_ROW_WIDTH = 24;

export interface GridPos {
    x: number;
    y: number;
    w: number;
    h: number;
}

function asGridPos(panel: PanelRecord): GridPos | undefined {
    const gp = panel.gridPos;
    if (!gp || typeof gp !== 'object' || Array.isArray(gp)) {
        return undefined;
    }
    const rec = gp as Record<string, unknown>;
    if (typeof rec.x !== 'number' || typeof rec.y !== 'number') {
        return undefined;
    }
    return {
        x: rec.x,
        y: rec.y,
        w: typeof rec.w === 'number' ? rec.w : DASHBOARD_TITLE_ROW_WIDTH,
        h: typeof rec.h === 'number' ? rec.h : DASHBOARD_TITLE_ROW_HEIGHT,
    };
}

export function titleRowMarkdown(label: string): string {
    const trimmed = label.trim();
    if (!trimmed) {
        return '# Dashboard';
    }
    return trimmed.startsWith('#') ? trimmed : `# ${trimmed}`;
}

export function buildDashboardTitleTextPanel(label: string, panelId: number): PanelRecord {
    return {
        id: panelId,
        type: 'text',
        title: '',
        gridPos: { x: 0, y: 0, w: DASHBOARD_TITLE_ROW_WIDTH, h: DASHBOARD_TITLE_ROW_HEIGHT },
        fieldConfig: { defaults: {}, overrides: [] },
        options: {
            mode: 'markdown',
            content: titleRowMarkdown(label),
        },
    };
}

export function panelLooksLikeDashboardTitleRow(panel: PanelRecord, label?: string): boolean {
    if (panel.type !== 'text') {
        return false;
    }
    const options = panel.options as { mode?: string; content?: string } | undefined;
    if (options?.mode !== 'markdown') {
        return false;
    }
    const content = typeof options.content === 'string' ? options.content.trim() : '';
    if (!content.startsWith('#')) {
        return false;
    }
    if (!label) {
        return true;
    }
    return content.toLowerCase() === titleRowMarkdown(label).toLowerCase();
}

export function shiftPanelGridPos(panel: PanelRecord, deltaY: number): void {
    const gp = asGridPos(panel);
    if (gp) {
        panel.gridPos = { ...gp, y: gp.y + deltaY };
    }
    const nested = panel.panels;
    if (!Array.isArray(nested)) {
        return;
    }
    for (const child of nested) {
        if (child && typeof child === 'object') {
            shiftPanelGridPos(child as PanelRecord, deltaY);
        }
    }
}

export function maxTopLevelPanelId(panels: unknown): number {
    if (!Array.isArray(panels)) {
        return 0;
    }
    let max = 0;
    for (const item of panels) {
        if (!item || typeof item !== 'object') {
            continue;
        }
        const id = (item as PanelRecord).id;
        if (typeof id === 'number' && id > max) {
            max = id;
        }
    }
    return max;
}

function minTopLevelGridY(panels: PanelRecord[], exclude?: PanelRecord): number {
    let min = Number.POSITIVE_INFINITY;
    for (const panel of panels) {
        if (panel === exclude) {
            continue;
        }
        const gp = asGridPos(panel);
        if (gp) {
            min = Math.min(min, gp.y);
        }
    }
    return Number.isFinite(min) ? min : 0;
}

/** Title row is first in array, at y=0, and other panels start at or below the title band. */
export function isDashboardTitleRowLayoutApplied(
    panels: PanelRecord[],
    titlePanel: PanelRecord
): boolean {
    if (!panels.length || panels[0] !== titlePanel) {
        return false;
    }
    const gp = asGridPos(titlePanel);
    if (!gp || gp.y !== 0 || gp.x !== 0 || gp.w !== DASHBOARD_TITLE_ROW_WIDTH) {
        return false;
    }
    return minTopLevelGridY(panels, titlePanel) >= DASHBOARD_TITLE_ROW_HEIGHT;
}

export interface ApplyDashboardTitleRowResult {
    panels: PanelRecord[];
    titlePanel: PanelRecord;
    created: boolean;
    shiftedPanels: number;
}

/**
 * Insert or repair a full-width markdown title row at the top.
 * Grafana uses gridPos for layout; y=0 alone is not enough when other panels also sit on row 0.
 */
export function applyDashboardTitleRow(
    panels: PanelRecord[],
    label: string,
    opts?: { existingTitlePanelId?: number }
): ApplyDashboardTitleRowResult {
    let titlePanel =
        (opts?.existingTitlePanelId != null
            ? panels.find((p) => p.id === opts.existingTitlePanelId)
            : undefined) ??
        panels.find((p) => panelLooksLikeDashboardTitleRow(p, label)) ??
        panels.find((p) => panelLooksLikeDashboardTitleRow(p));

    const created = !titlePanel;
    if (!titlePanel) {
        titlePanel = buildDashboardTitleTextPanel(label, maxTopLevelPanelId(panels) + 1);
    } else {
        const options = (titlePanel.options ?? {}) as Record<string, unknown>;
        titlePanel.options = {
            ...options,
            mode: 'markdown',
            content: titleRowMarkdown(label),
        };
        titlePanel.title = '';
        titlePanel.type = 'text';
    }

    titlePanel.gridPos = {
        x: 0,
        y: 0,
        w: DASHBOARD_TITLE_ROW_WIDTH,
        h: DASHBOARD_TITLE_ROW_HEIGHT,
    };

    const others = panels.filter((p) => p !== titlePanel);
    let shiftedPanels = 0;
    if (!isDashboardTitleRowLayoutApplied([titlePanel, ...others], titlePanel)) {
        for (const panel of others) {
            shiftPanelGridPos(panel, DASHBOARD_TITLE_ROW_HEIGHT);
            shiftedPanels++;
        }
    }

    return {
        panels: [titlePanel, ...others],
        titlePanel,
        created,
        shiftedPanels,
    };
}
