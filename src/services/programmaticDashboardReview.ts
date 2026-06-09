import type { ToolExecution } from '../types/llm.types';
import { extractDashboardFromGetByUid } from './programmaticDashboardClone';
import { callMcpTool } from './mcpToolClient';
import type { McpClient } from './dashboardChunkedUpdate';
import { listDashboardPanels, type DashboardPanelEntry } from './panelDiscovery';
import {
    layoutIssuesSummary,
    validateDashboardLayout,
    type LayoutValidationIssue,
} from './dashboardLayoutValidate';
import type { DashboardReviewRequest } from './dashboardReviewParse';
import { DASHBOARD_REVIEW_EXAMPLE_PROMPT } from './dashboardReviewParse';

type PanelRecord = Record<string, unknown>;

export interface ReadabilitySuggestion {
    title: string;
    detail: string;
    priority: number;
}

export interface DashboardReviewResult {
    ok: boolean;
    error?: string;
    toolExecutions: ToolExecution[];
    dashboardUid?: string;
    dashboardTitle?: string;
    panelCount?: number;
    suggestions: ReadabilitySuggestion[];
}

function pendingTool(name: string): ToolExecution {
    return { name, status: 'pending' };
}

function finishTool(step: ToolExecution, outcome: { ok: boolean; error?: string; summary?: string }): ToolExecution {
    return { ...step, status: outcome.ok ? 'success' : 'error', error: outcome.error, summary: outcome.summary };
}

function normalizeTitle(title: string): string {
    return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

function isContentPanel(entry: DashboardPanelEntry): boolean {
    const type = String(entry.panel.type ?? '');
    return type !== 'row' && Boolean(entry.title.trim());
}

function findDuplicateTitleGroups(entries: DashboardPanelEntry[]): Array<{ title: string; count: number }> {
    const counts = new Map<string, { display: string; count: number }>();
    for (const entry of entries) {
        if (!isContentPanel(entry)) {
            continue;
        }
        const key = normalizeTitle(entry.title);
        const existing = counts.get(key);
        if (existing) {
            existing.count++;
        } else {
            counts.set(key, { display: entry.title.trim(), count: 1 });
        }
    }
    return [...counts.values()]
        .filter((g) => g.count > 1)
        .sort((a, b) => b.count - a.count)
        .map((g) => ({ title: g.display, count: g.count }));
}

const CONSOLIDATION_KEYWORDS = [
    'level',
    'voltage',
    'sensing',
    'temperature',
    'pressure',
    'current',
    'cartridge',
    'module',
] as const;

function findConsolidationGroups(entries: DashboardPanelEntry[]): Array<{ keyword: string; count: number; titles: string[] }> {
    const groups: Array<{ keyword: string; count: number; titles: string[] }> = [];
    for (const keyword of CONSOLIDATION_KEYWORDS) {
        const matches = entries.filter(
            (e) => isContentPanel(e) && normalizeTitle(e.title).includes(keyword)
        );
        if (matches.length >= 3) {
            groups.push({
                keyword,
                count: matches.length,
                titles: matches.slice(0, 4).map((m) => m.title),
            });
        }
    }
    return groups.sort((a, b) => b.count - a.count);
}

function countPanelsByType(entries: DashboardPanelEntry[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const entry of entries) {
        const type = String(entry.panel.type ?? 'unknown');
        counts[type] = (counts[type] ?? 0) + 1;
    }
    return counts;
}

function suggestionFromLayoutIssue(issue: LayoutValidationIssue): ReadabilitySuggestion | null {
    switch (issue.code) {
        case 'grid_overlap':
            return {
                title: 'Fix overlapping panels',
                detail: issue.message,
                priority: 90,
            };
        case 'title_row_order':
        case 'title_row_overlap':
            return {
                title: 'Add a dedicated title row at the top',
                detail:
                    'Move the dashboard title into a full-width text panel at y=0 so KPI panels start below a clear header band.',
                priority: 85,
            };
        case 'module_block_position':
            return {
                title: 'Move Module blocks to the bottom',
                detail:
                    'Module N Current panels are interspersed with instrumentation — group them in a single block below overview panels.',
                priority: 80,
            };
        default:
            return null;
    }
}

export function analyzeDashboardReadability(
    panels: PanelRecord[],
    suggestionCount: number
): ReadabilitySuggestion[] {
    const entries = listDashboardPanels(panels);
    const contentPanels = entries.filter(isContentPanel);
    const candidates: ReadabilitySuggestion[] = [];

    const duplicates = findDuplicateTitleGroups(entries);
    for (const dup of duplicates) {
        candidates.push({
            title: `Remove duplicate **${dup.title}** panels`,
            detail: `${dup.count} panels share the same title — keep one canonical panel and delete or merge the rest.`,
            priority: 95,
        });
    }

    const consolidate = findConsolidationGroups(entries);
    for (const group of consolidate) {
        if (duplicates.some((d) => normalizeTitle(d.title).includes(group.keyword))) {
            continue;
        }
        const sample = group.titles.map((t) => `“${t}”`).join(', ');
        candidates.push({
            title: `Consolidate ${group.keyword} metrics`,
            detail: `${group.count} panels relate to **${group.keyword}** (e.g. ${sample}) — merge into one row or a single multi-series timeseries.`,
            priority: 88 - consolidate.indexOf(group),
        });
    }

    const rowPanels = panels.filter((p) => p.type === 'row').length;
    if (contentPanels.length >= 8 && rowPanels < 2) {
        candidates.push({
            title: 'Add row headers for visual hierarchy',
            detail: `The dashboard has ${contentPanels.length} content panels but only ${rowPanels} row header(s). Add Grafana row panels to separate instrumentation, trends, and module sections.`,
            priority: 82,
        });
    }

    const layoutIssues = validateDashboardLayout(panels);
    for (const issue of layoutIssues) {
        const suggestion = suggestionFromLayoutIssue(issue);
        if (suggestion) {
            candidates.push(suggestion);
        }
    }
    if (layoutIssues.length > 0 && !candidates.some((c) => c.title.includes('row header'))) {
        const summary = layoutIssuesSummary(layoutIssues);
        if (summary) {
            candidates.push({
                title: 'Resolve layout overlap issues',
                detail: summary.replace(/^- /gm, ''),
                priority: 75,
            });
        }
    }

    const byType = countPanelsByType(entries);
    const statCount = (byType.stat ?? 0) + (byType.gauge ?? 0);
    const timeseriesCount = byType.timeseries ?? 0;
    if (statCount >= 12 && statCount > timeseriesCount * 2) {
        candidates.push({
            title: 'Reduce stat-panel clutter',
            detail: `${statCount} stat/gauge panels vs ${timeseriesCount} timeseries — group KPIs in a compact top row and move detailed trends into fewer wider charts.`,
            priority: 70,
        });
    }

    const untitled = entries.filter((e) => !e.title.trim() && String(e.panel.type ?? '') !== 'row').length;
    if (untitled >= 2) {
        candidates.push({
            title: 'Name untitled panels',
            detail: `${untitled} panels have no title — add short descriptive titles so the panel index and legend stay readable.`,
            priority: 65,
        });
    }

    if (candidates.length === 0) {
        candidates.push({
            title: 'Tighten panel grid spacing',
            detail: 'Use consistent 4- or 6-unit stat widths and align related panels on the same row so scanning left-to-right matches physical signal groups.',
            priority: 50,
        });
        candidates.push({
            title: 'Add section row headers',
            detail: 'Even on a clean layout, row headers (“Instrumentation”, “Trends”, “Modules”) help operators jump to the right band quickly.',
            priority: 45,
        });
        candidates.push({
            title: 'Standardize panel titles',
            detail: 'Use a consistent pattern (signal · unit · location) so similarly named metrics are easy to distinguish in search and exports.',
            priority: 40,
        });
    }

    const seen = new Set<string>();
    const ranked: ReadabilitySuggestion[] = [];
    for (const item of [...candidates].sort((a, b) => b.priority - a.priority)) {
        const key = normalizeTitle(item.title);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        ranked.push(item);
        if (ranked.length >= suggestionCount) {
            break;
        }
    }

    return ranked;
}

export async function runProgrammaticDashboardReview(
    mcpClient: McpClient,
    request: DashboardReviewRequest
): Promise<DashboardReviewResult> {
    const toolExecutions: ToolExecution[] = [];
    const getStep = pendingTool('get_dashboard_by_uid');
    toolExecutions.push(getStep);
    const fetch = await callMcpTool(mcpClient, 'get_dashboard_by_uid', { uid: request.dashboardUid });
    toolExecutions[toolExecutions.length - 1] = finishTool(getStep, fetch);
    if (!fetch.ok) {
        return {
            ok: false,
            error: fetch.error ?? 'Could not load dashboard',
            toolExecutions,
            dashboardUid: request.dashboardUid,
            suggestions: [],
        };
    }

    const extracted = extractDashboardFromGetByUid(fetch.text);
    if (!extracted?.dashboard) {
        return {
            ok: false,
            error: 'Could not parse dashboard JSON',
            toolExecutions,
            dashboardUid: request.dashboardUid,
            suggestions: [],
        };
    }

    const dashboardTitle = typeof extracted.dashboard.title === 'string' ? extracted.dashboard.title : undefined;
    const panels = Array.isArray(extracted.dashboard.panels) ? (extracted.dashboard.panels as PanelRecord[]) : [];
    const entries = listDashboardPanels(panels);
    const suggestions = analyzeDashboardReadability(panels, request.suggestionCount);

    return {
        ok: true,
        toolExecutions,
        dashboardUid: request.dashboardUid,
        dashboardTitle,
        panelCount: entries.length,
        suggestions,
    };
}

export function formatDashboardReviewReply(result: DashboardReviewResult, buildNumber: string | number): string {
    if (!result.ok) {
        return (
            `### Dashboard review — failed (build ${buildNumber})\n\n` +
            `${result.error ?? 'Unknown error'}\n\n` +
            `Example:\n\n\`\`\`text\n${DASHBOARD_REVIEW_EXAMPLE_PROMPT}\n\`\`\``
        );
    }

    const titleLine = result.dashboardTitle
        ? `**${result.dashboardTitle}** (\`${result.dashboardUid}\`)`
        : `\`${result.dashboardUid}\``;
    const lines = [
        `### Dashboard review — readability suggestions (build ${buildNumber})`,
        '',
        `Reviewed ${titleLine} — **${result.panelCount ?? 0}** panel(s) inspected. Suggestions only; no changes were saved.`,
        '',
    ];

    result.suggestions.forEach((s, i) => {
        lines.push(`${i + 1}. ${s.title} — ${s.detail}`);
    });

    return lines.join('\n');
}
