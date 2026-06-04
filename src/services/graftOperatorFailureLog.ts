const STORAGE_KEY = 'graft-operator-failures';
const MAX_ENTRIES = 200;

export interface GraftFailureEntry {
    id: string;
    at: number;
    buildNumber: number;
    intent: string;
    userMessagePreview: string;
    error: string;
    dashboardTitle?: string;
    panelTitle?: string;
}

function readAll(): GraftFailureEntry[] {
    if (typeof localStorage === 'undefined') {
        return [];
    }
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) {
            return [];
        }
        const parsed = JSON.parse(raw) as GraftFailureEntry[];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function writeAll(entries: GraftFailureEntry[]): void {
    if (typeof localStorage === 'undefined') {
        return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
}

export function recordGraftFailure(
    entry: Omit<GraftFailureEntry, 'id' | 'at'> & { userMessagePreview: string }
): GraftFailureEntry {
    const row: GraftFailureEntry = {
        ...entry,
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        at: Date.now(),
        userMessagePreview: entry.userMessagePreview.slice(0, 2000),
    };
    const next = [row, ...readAll()].slice(0, MAX_ENTRIES);
    writeAll(next);
    return row;
}

export function listGraftFailures(): GraftFailureEntry[] {
    return readAll();
}

export function clearGraftFailures(): void {
    writeAll([]);
}

export function exportGraftFailuresAsJson(): string {
    return JSON.stringify(readAll(), null, 2);
}

export function exportGraftFailuresAsMarkdown(): string {
    const rows = readAll();
    if (rows.length === 0) {
        return '# Graft operator failures\n\n_No entries._\n';
    }
    const lines = ['# Graft operator failures', ''];
    for (const r of rows) {
        lines.push(`## ${new Date(r.at).toISOString()} — ${r.intent} (build ${r.buildNumber})`);
        lines.push('');
        if (r.dashboardTitle) {
            lines.push(`- **Dashboard:** ${r.dashboardTitle}`);
        }
        if (r.panelTitle) {
            lines.push(`- **Panel:** ${r.panelTitle}`);
        }
        lines.push(`- **Error:** ${r.error}`);
        lines.push('');
        lines.push('**User message (preview):**');
        lines.push('');
        lines.push('```');
        lines.push(r.userMessagePreview);
        lines.push('```');
        lines.push('');
    }
    return lines.join('\n');
}
