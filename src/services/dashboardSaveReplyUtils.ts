import type { ToolExecution } from '../types/llm.types';
import { extractDashboardUidFromMessage } from './dashboardMentionParse';
import { messageDescribesPanelRename, userWantsPanelRename } from './panelRenameParse';
import { parseSearchHitsFromToolExecutions } from './dashboardSearchParse';
import { stripPanelIndexTables } from './dashboardTaskStatus';

export function hasSuccessfulDashboardSave(toolExecutions: ToolExecution[]): boolean {
    return toolExecutions.some((t) => t.name === 'update_dashboard' && t.status === 'success');
}

export function savedVersionFromTools(toolExecutions: ToolExecution[]): string | undefined {
    for (const t of [...toolExecutions].reverse()) {
        if (t.name !== 'update_dashboard' || t.status !== 'success') {
            continue;
        }
        const v = t.summary?.match(/version=(\d+)/i)?.[1];
        if (v) {
            return v;
        }
    }
    return undefined;
}

export function savedUidFromTools(toolExecutions: ToolExecution[]): string | undefined {
    for (const t of [...toolExecutions].reverse()) {
        if (t.name !== 'update_dashboard' || t.status !== 'success') {
            continue;
        }
        const uid = t.summary?.match(/uid=([a-z0-9]+)/i)?.[1];
        if (uid) {
            return uid;
        }
    }
    return undefined;
}

export function resolveSavedDashboardLabel(
    toolExecutions: ToolExecution[],
    userMessage: string,
    modelText: string
): string {
    const uid =
        savedUidFromTools(toolExecutions) ??
        extractDashboardUidFromMessage(userMessage) ??
        modelText.match(/uid[=\s`]+([a-z0-9]+)/i)?.[1];
    const hits = parseSearchHitsFromToolExecutions(toolExecutions);
    const title =
        hits.find((h) => !uid || h.uid === uid)?.title ??
        modelText.match(/\*\*([0-9]{4}-[0-9]+[^*]*)\*\*/)?.[1]?.trim() ??
        userMessage.match(/([0-9]{4}-[0-9]+(?:\s*\/\s*[^\n.(]+)?)/)?.[1]?.trim();

    if (title) {
        return uid ? `**${title}** (uid \`${uid}\`)` : `**${title}**`;
    }
    if (uid) {
        return `dashboard uid \`${uid}\``;
    }
    return 'your dashboard';
}

export function extractSuccessLineFromModel(text: string): string | undefined {
    const stripped = stripPanelIndexTables(text);
    const checkmark = stripped.match(/✅[^\n|]+/i)?.[0]?.trim();
    if (checkmark) {
        return checkmark.replace(/^✅\s*/u, '').trim();
    }

    for (const line of stripped.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.length > 220) {
            continue;
        }
        if (/^\|/.test(trimmed) || /^#{1,3}\s/.test(trimmed)) {
            continue;
        }
        if (
            /\b(saved|updated|created|replaced|added|copied|finished)\b/i.test(trimmed) &&
            !/\b(will|going to|I'll|let me)\b/i.test(trimmed)
        ) {
            return trimmed.replace(/\*\*/g, '').trim();
        }
    }
    return undefined;
}

export function describeDefaultSaveOutcome(userMessage: string): string {
    if (userWantsPanelRename(userMessage) || messageDescribesPanelRename(userMessage)) {
        return 'Panel renamed and saved';
    }
    if (/\b(rename|retitle)\b/i.test(userMessage) && /\bdashboard\b/i.test(userMessage)) {
        return 'Dashboard renamed and saved';
    }
    if (/\b(add|create|new)\b/i.test(userMessage) && /\bpanel/i.test(userMessage)) {
        return 'Panel changes saved';
    }
    if (/\b(update|modify|change|edit|fix)\b/i.test(userMessage)) {
        return 'Dashboard updated and saved';
    }
    return 'Dashboard saved';
}

/** Short uid list after search-only turns (no full panel index tables in chat). */
export function formatCompactLookupHint(toolExecutions: ToolExecution[]): string {
    const hits = parseSearchHitsFromToolExecutions(toolExecutions);
    if (hits.length === 0) {
        return '';
    }
    const lines = hits.slice(0, 4).map((h, i) => `${i + 1}. **${h.title}** — uid \`${h.uid}\``);
    return (
        `**Dashboards found** (use uid in follow-ups; full panel index omitted from chat):\n` +
        `${lines.join('\n')}`
    );
}

export const HARD_REFRESH_LINE =
    '**What to do:** Hard-refresh the dashboard in Grafana (**Cmd+Shift+R** on Mac) to see changes.';
