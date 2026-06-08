import {
    collectUniqueRegistrySuggestions,
    formatRegistrySuggestionMarkdown,
    suggestRegistryRowForFailure,
} from './graftFailureRegistrySuggest';

const STORAGE_KEY = 'graft-operator-failures';
const MAX_ENTRIES = 200;

const listeners = new Set<() => void>();

function notifyFailureLogChanged(): void {
    for (const listener of listeners) {
        listener();
    }
}

/** Subscribe to local failure log changes (record / clear). */
export function subscribeGraftFailures(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

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
    notifyFailureLogChanged();
    return row;
}

export function listGraftFailures(): GraftFailureEntry[] {
    return readAll();
}

export function clearGraftFailures(): void {
    writeAll([]);
    notifyFailureLogChanged();
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

export function exportGraftOperatorReportAsMarkdown(): string {
    const rows = readAll();
    const lines = [
        '# Graft operator failure report',
        '',
        `_Generated ${new Date().toISOString()} · ${rows.length} failure(s) in this browser_`,
        '',
    ];

    if (rows.length === 0) {
        lines.push('No failures recorded in this browser session storage.');
        lines.push('');
        lines.push('Failures are logged when programmatic paths error or when LLM dashboard work stalls.');
        return lines.join('\n');
    }

    lines.push('## Failure log', '');
    for (const r of rows) {
        const suggestion = suggestRegistryRowForFailure(r);
        lines.push(`### ${new Date(r.at).toISOString()} — \`${r.intent}\` (build ${r.buildNumber})`);
        lines.push('');
        if (r.dashboardTitle) {
            lines.push(`- **Dashboard:** ${r.dashboardTitle}`);
        }
        if (r.panelTitle) {
            lines.push(`- **Panel:** ${r.panelTitle}`);
        }
        lines.push(`- **Error:** ${r.error}`);
        lines.push(`- **Suggested registry kind:** \`${suggestion.kind}\` (${suggestion.status})`);
        lines.push('');
        lines.push('**User message:**');
        lines.push('');
        lines.push('```text');
        lines.push(r.userMessagePreview);
        lines.push('```');
        lines.push('');
    }

    lines.push('## Suggested programmatic registry rows (deduped)', '');
    lines.push(
        'Add or extend these in `PROGRAMMATIC_FALLBACK_REGISTRY` and wire parse + handler when status is **missing**.'
    );
    lines.push('');
    for (const row of collectUniqueRegistrySuggestions(rows)) {
        lines.push(...formatRegistrySuggestionMarkdown(row));
    }

    return lines.join('\n');
}

export function exportGraftOperatorReportAsJson(): string {
    const rows = readAll();
    return JSON.stringify(
        {
            exportedAt: new Date().toISOString(),
            failureCount: rows.length,
            failures: rows,
            suggestedRegistryRows: collectUniqueRegistrySuggestions(rows),
        },
        null,
        2
    );
}

export function downloadTextFile(filename: string, content: string, mimeType: string): void {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
}
