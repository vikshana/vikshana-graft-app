import type { ToolExecution } from '../types/llm.types';
import { extractDashboardFromGetByUid } from './programmaticDashboardClone';
import { callMcpTool } from './mcpToolClient';
import { saveDashboardInPanelChunks, type McpClient } from './dashboardChunkedUpdate';
import { findFluxBrokenPanels, listDashboardPanels } from './panelDiscovery';
import { applyDashboardTitleRow } from './dashboardTitleRowLayout';
import type { DashboardImproveRequest } from './dashboardReviewParse';

type PanelRecord = Record<string, unknown>;

export interface AppliedChange {
    kind: 'remove_duplicates' | 'title_row' | 'overlaps';
    detail: string;
}

export interface PendingSuggestion {
    title: string;
    detail: string;
}

export interface DashboardImproveResult {
    ok: boolean;
    error?: string;
    toolExecutions: ToolExecution[];
    dashboardUid?: string;
    dashboardTitle?: string;
    panelCount?: number;
    removedPanels: Array<{ id?: number; title: string }>;
    titleRowCreated: boolean;
    panelsShifted: number;
    overlapsFixed: number;
    chunksSaved?: number;
    totalChunks?: number;
    appliedChanges: AppliedChange[];
    pendingSuggestions: PendingSuggestion[];
    changedAnything: boolean;
}

function pendingTool(name: string): ToolExecution {
    return { name, status: 'pending' };
}

function finishTool(
    step: ToolExecution,
    outcome: { ok: boolean; error?: string; summary?: string }
): ToolExecution {
    return { ...step, status: outcome.ok ? 'success' : 'error', error: outcome.error, summary: outcome.summary };
}

function normalizeTitle(title: string): string {
    return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Stable signature of a panel's *data* (type + every target's query/datasource) so we only
 * treat panels as duplicates when their title AND their data are identical. Two panels that
 * merely share a title but pull different series must never be auto-removed.
 */
export function panelDataSignature(panel: PanelRecord): string {
    const targets = Array.isArray(panel.targets) ? panel.targets : [];
    const sig = targets.map((t) => {
        if (!t || typeof t !== 'object') {
            return '';
        }
        const o = t as Record<string, unknown>;
        const ds =
            o.datasource && typeof o.datasource === 'object'
                ? JSON.stringify(o.datasource)
                : String(o.datasource ?? '');
        return [o.expr, o.query, o.rawSql, o.rawQuery, ds]
            .map((v) => (v == null ? '' : String(v)))
            .join('|');
    });
    return `${String(panel.type ?? '')}::${sig.join('##')}`;
}

/**
 * Find exact-duplicate top-level content panels (same normalized title AND same data
 * signature). Keeps the first occurrence; returns the later ones for removal. Row panels
 * and untitled panels are never considered duplicates.
 */
export function findExactDuplicateTopLevelPanels(
    panels: PanelRecord[]
): Array<{ index: number; id?: number; title: string }> {
    const seen = new Set<string>();
    const dupes: Array<{ index: number; id?: number; title: string }> = [];
    for (let i = 0; i < panels.length; i++) {
        const p = panels[i];
        const type = String(p.type ?? '');
        const title = typeof p.title === 'string' ? p.title.trim() : '';
        if (type === 'row' || !title) {
            continue;
        }
        const key = `${normalizeTitle(title)}::${panelDataSignature(p)}`;
        if (seen.has(key)) {
            dupes.push({ index: i, id: typeof p.id === 'number' ? p.id : undefined, title });
        } else {
            seen.add(key);
        }
    }
    return dupes;
}

interface GridPos {
    x: number;
    y: number;
    w: number;
    h: number;
}

function readGridPos(panel: PanelRecord): GridPos | undefined {
    const gp = panel.gridPos;
    if (!gp || typeof gp !== 'object' || Array.isArray(gp)) {
        return undefined;
    }
    const rec = gp as Record<string, unknown>;
    if (typeof rec.x !== 'number' || typeof rec.y !== 'number' || typeof rec.w !== 'number' || typeof rec.h !== 'number') {
        return undefined;
    }
    return { x: rec.x, y: rec.y, w: rec.w, h: rec.h };
}

function gridOverlaps(a: GridPos, b: GridPos): boolean {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * Resolve overlapping top-level panels by nudging the later panel DOWN until it no longer
 * collides. Order, x, w, and h are preserved — the least-disruptive way to remove overlaps
 * (panels that sit side-by-side on the same row do not overlap and are untouched).
 */
export function resolveTopLevelOverlaps(panels: PanelRecord[]): number {
    let fixed = 0;
    const placed: GridPos[] = [];
    for (const panel of panels) {
        const g = readGridPos(panel);
        if (!g) {
            continue;
        }
        let moved = false;
        let guard = 0;
        while (placed.some((q) => gridOverlaps(g, q)) && guard < 10000) {
            g.y += 1;
            moved = true;
            guard++;
        }
        if (moved) {
            panel.gridPos = { ...(panel.gridPos as Record<string, unknown>), x: g.x, y: g.y, w: g.w, h: g.h };
            fixed++;
        }
        placed.push(g);
    }
    return fixed;
}

export interface SafeImprovementResult {
    dashboard: Record<string, unknown>;
    removedPanels: Array<{ id?: number; title: string }>;
    titleRowCreated: boolean;
    panelsShifted: number;
    overlapsFixed: number;
}

/**
 * Apply the safe, deterministic structural fixes to a deep clone of the dashboard:
 *   1. Remove exact-duplicate top-level panels.
 *   2. Add/repair a full-width title row at y=0.
 *   3. Resolve any remaining panel overlaps.
 * Returns the new dashboard plus a summary of what changed.
 */
export function applySafeStructuralImprovements(
    dashboard: Record<string, unknown>,
    opts: { titleLabel?: string }
): SafeImprovementResult {
    const clone = JSON.parse(JSON.stringify(dashboard)) as Record<string, unknown>;
    let panels = Array.isArray(clone.panels) ? (clone.panels as PanelRecord[]) : [];

    const dupes = findExactDuplicateTopLevelPanels(panels);
    const removeIdx = new Set(dupes.map((d) => d.index));
    const removedPanels = dupes.map((d) => ({ id: d.id, title: d.title }));
    if (removeIdx.size > 0) {
        panels = panels.filter((_, i) => !removeIdx.has(i));
    }

    const label = opts.titleLabel ?? (typeof clone.title === 'string' ? clone.title : 'Dashboard');
    const titleRow = applyDashboardTitleRow(panels, label);
    panels = titleRow.panels;

    const overlapsFixed = resolveTopLevelOverlaps(panels);

    clone.panels = panels;
    return {
        dashboard: clone,
        removedPanels,
        titleRowCreated: titleRow.created,
        panelsShifted: titleRow.shiftedPanels,
        overlapsFixed,
    };
}

/**
 * Detect the non-structural fixes Graft will NOT auto-apply (data/visual changes that need
 * human confirmation): broken queries, bar-chart-vs-timeseries, and missing units.
 */
export function detectPendingSuggestions(panels: PanelRecord[]): PendingSuggestion[] {
    const entries = listDashboardPanels(panels);
    const out: PendingSuggestion[] = [];

    for (const e of findFluxBrokenPanels(entries)) {
        out.push({
            title: `Fix broken query — ${e.title || `panel ${e.panelId ?? '?'}`}`,
            detail: `Panel id ${e.panelId ?? '?'} has broken Flux syntax. Confirm with: \`Fix the "${e.title}" panel on dashboard UID = <uid>\`.`,
        });
    }

    for (const e of entries) {
        if (String(e.panel.type) === 'barchart') {
            out.push({
                title: `Convert "${e.title}" bar chart → time series`,
                detail: `Panel id ${e.panelId ?? '?'} is a bar chart of time data; a time series usually reads better.`,
            });
        }
    }

    for (const e of entries) {
        const defaults = (e.panel.fieldConfig as { defaults?: { unit?: unknown } } | undefined)?.defaults;
        const unit = defaults?.unit;
        if ((!unit || unit === 'none') && /\b(current|voltage|amp|volt)\b/i.test(e.title)) {
            out.push({
                title: `Set a unit for "${e.title}"`,
                detail: `Panel id ${e.panelId ?? '?'} has no unit; current → \`ampere\`, voltage → \`volt\`.`,
            });
        }
    }

    return out;
}

export async function runProgrammaticDashboardImprove(
    mcpClient: McpClient,
    request: DashboardImproveRequest
): Promise<DashboardImproveResult> {
    const toolExecutions: ToolExecution[] = [];
    const emptyResult = (over: Partial<DashboardImproveResult>): DashboardImproveResult => ({
        ok: false,
        toolExecutions,
        dashboardUid: request.dashboardUid,
        removedPanels: [],
        titleRowCreated: false,
        panelsShifted: 0,
        overlapsFixed: 0,
        appliedChanges: [],
        pendingSuggestions: [],
        changedAnything: false,
        ...over,
    });

    const getStep = pendingTool('get_dashboard_by_uid');
    toolExecutions.push(getStep);
    const fetched = await callMcpTool(mcpClient, 'get_dashboard_by_uid', { uid: request.dashboardUid });
    toolExecutions[toolExecutions.length - 1] = finishTool(getStep, fetched);
    if (!fetched.ok) {
        return emptyResult({ error: fetched.error ?? 'Could not load dashboard' });
    }

    const extracted = extractDashboardFromGetByUid(fetched.text);
    if (!extracted?.dashboard) {
        return emptyResult({ error: 'Could not parse dashboard JSON' });
    }

    const baseline = extracted.dashboard;
    const dashboardTitle = typeof baseline.title === 'string' ? baseline.title : undefined;
    const originalPanels = Array.isArray(baseline.panels) ? (baseline.panels as PanelRecord[]) : [];
    const panelCount = listDashboardPanels(originalPanels).length;
    const pendingSuggestions = detectPendingSuggestions(originalPanels);

    const improved = applySafeStructuralImprovements(baseline, { titleLabel: dashboardTitle });

    const appliedChanges: AppliedChange[] = [];
    if (improved.removedPanels.length > 0) {
        appliedChanges.push({
            kind: 'remove_duplicates',
            detail: `Removed ${improved.removedPanels.length} exact-duplicate panel(s): ${improved.removedPanels
                .map((p) => `"${p.title}"`)
                .join(', ')}`,
        });
    }
    if (improved.titleRowCreated || improved.panelsShifted > 0) {
        appliedChanges.push({
            kind: 'title_row',
            detail: `${improved.titleRowCreated ? 'Added' : 'Repaired'} a full-width title row at the top${
                improved.panelsShifted > 0 ? ` and shifted ${improved.panelsShifted} panel(s) down` : ''
            }`,
        });
    }
    if (improved.overlapsFixed > 0) {
        appliedChanges.push({
            kind: 'overlaps',
            detail: `Resolved ${improved.overlapsFixed} overlapping panel position(s)`,
        });
    }

    const changedAnything = appliedChanges.length > 0;
    if (!changedAnything) {
        return {
            ok: true,
            toolExecutions,
            dashboardUid: request.dashboardUid,
            dashboardTitle,
            panelCount,
            removedPanels: [],
            titleRowCreated: false,
            panelsShifted: 0,
            overlapsFixed: 0,
            appliedChanges,
            pendingSuggestions,
            changedAnything: false,
        };
    }

    const save = await saveDashboardInPanelChunks(
        mcpClient,
        improved.dashboard,
        {
            targetUid: request.dashboardUid,
            overwrite: true,
            messagePrefix: 'Graft apply improvements',
        },
        toolExecutions
    );

    if (!save.ok) {
        return {
            ok: false,
            error: save.error ?? 'Failed to save improvements',
            toolExecutions,
            dashboardUid: request.dashboardUid,
            dashboardTitle,
            panelCount,
            removedPanels: improved.removedPanels,
            titleRowCreated: improved.titleRowCreated,
            panelsShifted: improved.panelsShifted,
            overlapsFixed: improved.overlapsFixed,
            chunksSaved: save.chunksSaved,
            totalChunks: save.totalChunks,
            appliedChanges,
            pendingSuggestions,
            changedAnything,
        };
    }

    return {
        ok: true,
        toolExecutions,
        dashboardUid: save.uid ?? request.dashboardUid,
        dashboardTitle,
        panelCount,
        removedPanels: improved.removedPanels,
        titleRowCreated: improved.titleRowCreated,
        panelsShifted: improved.panelsShifted,
        overlapsFixed: improved.overlapsFixed,
        chunksSaved: save.chunksSaved,
        totalChunks: save.totalChunks,
        appliedChanges,
        pendingSuggestions,
        changedAnything: true,
    };
}

export function formatDashboardImproveReply(
    result: DashboardImproveResult,
    buildNumber: string | number
): string {
    const titleLine = result.dashboardTitle
        ? `**${result.dashboardTitle}** (\`${result.dashboardUid}\`)`
        : `\`${result.dashboardUid}\``;

    if (!result.ok) {
        return (
            `### Could not apply improvements (Graft build ${buildNumber})\n\n` +
            `${result.error ?? 'Unknown error'}\n\n` +
            `Try: \`Suggest improvements and apply the changes to the dashboard with UID = <uid>\`.`
        );
    }

    const pendingBlock =
        result.pendingSuggestions.length > 0
            ? `\n\n**Needs your confirmation (data/visual changes Graft won't auto-apply):**\n` +
              result.pendingSuggestions.map((s) => `- ${s.title} — ${s.detail}`).join('\n')
            : '';

    if (!result.changedAnything) {
        return (
            `### Reviewed — no safe structural changes needed (Graft build ${buildNumber})\n\n` +
            `Reviewed ${titleLine} — **${result.panelCount ?? 0}** panel(s). ` +
            `Layout already has a title row, no duplicate panels, and no overlaps.` +
            pendingBlock
        );
    }

    const batches =
        result.totalChunks && result.totalChunks > 1 ? ` in ${result.totalChunks} batches` : '';

    return (
        `### Done — applied safe improvements (Graft build ${buildNumber})\n\n` +
        `Dashboard: ${titleLine} — **${result.panelCount ?? 0}** panel(s) reviewed, saved${batches}.\n\n` +
        `**Applied:**\n` +
        result.appliedChanges.map((c) => `- ${c.detail}`).join('\n') +
        pendingBlock +
        `\n\nHard-refresh the dashboard (**Cmd+Shift+R**) to see the changes.`
    );
}
