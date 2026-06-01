/**
 * Appends human- and LLM-readable UID / panel index tables to dashboard MCP tool results
 * so users can cite them in follow-up requests (faster than re-searching).
 */

function tryParseJson(text: string): unknown | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        return null;
    }
    try {
        return JSON.parse(trimmed);
    } catch {
        return null;
    }
}

interface SearchHit {
    uid?: string;
    title?: string;
    folderTitle?: string;
    folderUid?: string;
    tags?: string[];
}

interface SearchResult {
    dashboards?: SearchHit[];
    hasMore?: boolean;
}

interface PanelSummary {
    id?: number;
    title?: string;
    type?: string;
    queryCount?: number;
}

interface DashboardSummary {
    uid?: string;
    title?: string;
    panels?: PanelSummary[];
}

function escapeCell(value: string): string {
    return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function formatSearchDashboardReference(data: SearchResult): string {
    const hits = data.dashboards;
    if (!hits?.length) {
        return '';
    }

    const lines = [
        '',
        '---',
        '**Dashboard lookup reference** — include `uid` (and panel `arrayIndex` / `panelId`) in follow-up requests to skip search',
        '',
        '| # | Title | UID | Folder |',
        '|---|-------|-----|--------|',
    ];

    hits.forEach((d, i) => {
        lines.push(
            `| ${i + 1} | ${escapeCell(d.title || '(untitled)')} | \`${d.uid || '?'}\` | ${escapeCell(
                d.folderTitle || d.folderUid || '—'
            )} |`
        );
    });

    lines.push('');
    lines.push(
        '**Next step for panel numbers:** call `get_dashboard_summary` with the uid to list `arrayIndex` and `panelId`.'
    );
    lines.push(
        `**Example follow-up:** \`dashboard uid=${hits[0]?.uid || 'YOUR_UID'}, update panel index 2\``
    );
    if (data.hasMore) {
        lines.push('_(More results exist — refine search or paginate)_');
    }

    return lines.join('\n');
}

export function formatDashboardSummaryReference(data: DashboardSummary): string {
    const uid = data.uid || '?';
    const panels = data.panels;

    if (!panels?.length) {
        return `\n\n---\n**Panel index** for uid \`${uid}\`: no panels in summary.\n`;
    }

    const lines = [
        '',
        '---',
        `**Panel index** — uid \`${uid}\`${data.title ? ` · ${escapeCell(data.title)}` : ''}`,
        '',
        '| arrayIndex | panelId | Title | Type | JSON path |',
        '|:----------:|:-------:|-------|------|-----------|',
    ];

    panels.forEach((p, idx) => {
        lines.push(
            `| **${idx}** | ${p.id ?? '—'} | ${escapeCell(p.title || '(no title)')} | ${escapeCell(
                p.type || '—'
            )} | \`$.panels[${idx}]\` |`
        );
    });

    lines.push('');
    lines.push(
        '**Cite in requests:** `uid=' +
            uid +
            '`, `panel index N` (arrayIndex), or `panelId N` (panelId column). ' +
            'Show this table to the user when they searched by name.'
    );

    return lines.join('\n');
}

function extractPanelFromJson(p: unknown): PanelSummary {
    if (!p || typeof p !== 'object') {
        return {};
    }
    const po = p as Record<string, unknown>;
    return {
        id: typeof po.id === 'number' ? po.id : undefined,
        title: typeof po.title === 'string' ? po.title : undefined,
        type: typeof po.type === 'string' ? po.type : undefined,
    };
}

function collectPanelsFromDashboardJson(db: Record<string, unknown>): PanelSummary[] {
    const panels: PanelSummary[] = [];
    const topPanels = db.panels;
    if (!Array.isArray(topPanels)) {
        return panels;
    }
    for (const p of topPanels) {
        if (!p || typeof p !== 'object') {
            continue;
        }
        const po = p as Record<string, unknown>;
        if (po.type === 'row' && Array.isArray(po.panels)) {
            for (const nested of po.panels) {
                panels.push(extractPanelFromJson(nested));
            }
        } else if (po.type !== 'row') {
            panels.push(extractPanelFromJson(po));
        }
    }
    return panels;
}

/** Build panel index table from get_dashboard_by_uid JSON. */
export function formatPanelIndexFromDashboardJson(data: unknown): string {
    if (!data || typeof data !== 'object') {
        return '';
    }
    const root = data as Record<string, unknown>;
    const db = (root.dashboard as Record<string, unknown> | undefined) ?? root;
    const uid = String(db.uid ?? '?');
    const title = typeof db.title === 'string' ? db.title : undefined;
    const panels = collectPanelsFromDashboardJson(db);
    return formatDashboardSummaryReference({ uid, title, panels });
}

/**
 * Markdown reference for the chat UI (uid / panel index tables).
 * Shown to the user even when the model omits them from its reply.
 */
export function getDashboardUserReference(toolName: string, text: string): string | undefined {
    const parsed = tryParseJson(text);
    if (parsed === null) {
        return undefined;
    }

    let block = '';
    switch (toolName) {
        case 'search_dashboards':
        case 'search_folders':
            block = formatSearchDashboardReference(parsed as SearchResult);
            break;
        case 'get_dashboard_summary':
            block = formatDashboardSummaryReference(parsed as DashboardSummary);
            break;
        case 'get_dashboard_by_uid':
            block = formatPanelIndexFromDashboardJson(parsed);
            break;
        default:
            return undefined;
    }

    const trimmed = block.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

export function enrichDashboardToolResult(toolName: string, text: string): string {
    const parsed = tryParseJson(text);
    if (parsed === null) {
        return text;
    }

    switch (toolName) {
        case 'search_dashboards':
        case 'search_folders':
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                return text + formatSearchDashboardReference(parsed as SearchResult);
            }
            return text;
        case 'get_dashboard_summary':
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                return text + formatDashboardSummaryReference(parsed as DashboardSummary);
            }
            return text;
        case 'get_dashboard_panel_queries':
            if (Array.isArray(parsed) && parsed.length > 0) {
                return (
                    text +
                    '\n\n---\n**Panel IDs / arrayIndex:** use `get_dashboard_summary` on this dashboard uid for the index table.\n'
                );
            }
            return text;
        default:
            return text;
    }
}

export function summarizeDashboardTool(toolName: string, text: string): string | undefined {
    const parsed = tryParseJson(text);
    if (!parsed || typeof parsed !== 'object') {
        return undefined;
    }

    if (toolName === 'search_dashboards' || toolName === 'search_folders') {
        const hits = (parsed as SearchResult).dashboards;
        if (!hits?.length) {
            return 'No dashboards found';
        }
        const uids = hits
            .slice(0, 3)
            .map((h) => h.uid)
            .filter(Boolean)
            .join(', ');
        const more = hits.length > 3 ? ` (+${hits.length - 3} more)` : '';
        return `Found ${hits.length}: uid ${uids}${more}`;
    }

    if (toolName === 'get_dashboard_summary') {
        const summary = parsed as DashboardSummary;
        const n = summary.panels?.length ?? 0;
        return `uid=${summary.uid ?? '?'}, ${n} panel(s) indexed`;
    }

    return undefined;
}
