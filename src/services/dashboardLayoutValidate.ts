import { listDashboardPanels } from './panelDiscovery';
import {
    computeModulePanelSectionStartY,
    selectModuleCurrentPanels,
} from './programmaticModulePanelReorder';
import {
    isDashboardTitleRowLayoutApplied,
    panelLooksLikeDashboardTitleRow,
} from './dashboardTitleRowLayout';

type PanelRecord = Record<string, unknown>;

export type LayoutValidationCode =
    | 'grid_overlap'
    | 'title_row_order'
    | 'title_row_overlap'
    | 'module_block_position';

export interface LayoutValidationIssue {
    code: LayoutValidationCode;
    message: string;
    panelIds?: number[];
}

interface GridRect {
    id?: number;
    title?: string;
    x: number;
    y: number;
    w: number;
    h: number;
}

function gridRect(panel: PanelRecord): GridRect | undefined {
    const gp = panel.gridPos;
    if (!gp || typeof gp !== 'object' || Array.isArray(gp)) {
        return undefined;
    }
    const rec = gp as Record<string, unknown>;
    if (typeof rec.y !== 'number') {
        return undefined;
    }
    return {
        id: typeof panel.id === 'number' ? panel.id : undefined,
        title: typeof panel.title === 'string' ? panel.title : undefined,
        x: typeof rec.x === 'number' ? rec.x : 0,
        y: rec.y,
        w: typeof rec.w === 'number' ? rec.w : 24,
        h: typeof rec.h === 'number' ? rec.h : 8,
    };
}

function rectsOverlap(a: GridRect, b: GridRect): boolean {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function findTitlePanel(panels: PanelRecord[]): PanelRecord | undefined {
    return panels.find((p) => panelLooksLikeDashboardTitleRow(p));
}

/** Detect known PowerTech layout defects after an LLM or manual save. */
export function validateDashboardLayout(panels: PanelRecord[]): LayoutValidationIssue[] {
    const issues: LayoutValidationIssue[] = [];
    const topLevel = panels.filter((p) => p.type !== 'row' || !p.panels);

    const rects: GridRect[] = [];
    for (const panel of panels) {
        if (panel.type === 'row') {
            continue;
        }
        const rect = gridRect(panel);
        if (rect) {
            rects.push(rect);
        }
    }

    for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
            if (rectsOverlap(rects[i], rects[j])) {
                issues.push({
                    code: 'grid_overlap',
                    message: `Panels "${rects[i].title ?? rects[i].id}" and "${rects[j].title ?? rects[j].id}" overlap at y=${rects[i].y}/${rects[j].y}.`,
                    panelIds: [rects[i].id, rects[j].id].filter((id): id is number => id != null),
                });
            }
        }
    }

    const titlePanel = findTitlePanel(topLevel);
    if (titlePanel) {
        if (topLevel[0] !== titlePanel) {
            issues.push({
                code: 'title_row_order',
                message: 'Title text panel is not first in the panel array.',
                panelIds: typeof titlePanel.id === 'number' ? [titlePanel.id] : undefined,
            });
        }
        if (!isDashboardTitleRowLayoutApplied([titlePanel, ...topLevel.filter((p) => p !== titlePanel)], titlePanel)) {
            issues.push({
                code: 'title_row_overlap',
                message: 'Title row is not at y=0 or other panels share the title band (y < 2).',
                panelIds: typeof titlePanel.id === 'number' ? [titlePanel.id] : undefined,
            });
        }
    }

    const entries = listDashboardPanels(panels);
    const moduleEntries = selectModuleCurrentPanels(entries, true);
    if (moduleEntries.length > 0) {
        const expectedStart = computeModulePanelSectionStartY(entries, true);
        const minModuleY = Math.min(
            ...moduleEntries.map((e) => {
                const gp = e.panel.gridPos as { y?: number } | undefined;
                return typeof gp?.y === 'number' ? gp.y : 0;
            })
        );
        if (minModuleY < expectedStart - 1) {
            issues.push({
                code: 'module_block_position',
                message: `Module N Current block starts at y=${minModuleY} but should start at y=${expectedStart} (below other panels).`,
            });
        }
    }

    return issues;
}

export function layoutIssuesSummary(issues: LayoutValidationIssue[]): string {
    if (!issues.length) {
        return '';
    }
    return issues.map((i) => `- ${i.message}`).join('\n');
}

export function layoutNeedsProgrammaticRepair(issues: LayoutValidationIssue[]): boolean {
    return issues.some((i) =>
        ['grid_overlap', 'title_row_order', 'title_row_overlap', 'module_block_position'].includes(i.code)
    );
}

export function suggestRepairForLayoutIssues(issues: LayoutValidationIssue[]): 'rebuild' | 'title_row' | 'module_reorder' | null {
    if (issues.some((i) => i.code === 'module_block_position')) {
        return 'module_reorder';
    }
    if (issues.some((i) => i.code.startsWith('title_row'))) {
        return 'title_row';
    }
    if (issues.some((i) => i.code === 'grid_overlap')) {
        return 'rebuild';
    }
    return null;
}
