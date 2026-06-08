import { extractAllDashboardUids } from './dashboardMentionParse';
import { findMachineIdsInText, isMachineId, MACHINE_ID_PATTERN } from './dashboardCloneParse';
import { messageDescribesPanelRename } from './panelRenameParse';

export interface DashboardRenameRequest {
    machineId?: string;
    dashboardUid?: string;
    /** Label after the machine id in titles like `2505-200033 / Keysight`. */
    replaceLabel?: string;
    newLabel: string;
    /** Full title when user quotes it explicitly. */
    newTitle?: string;
}

function normalizeMessageQuotes(text: string): string {
    return text.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
}

export function messageDescribesDashboardRename(message: string): boolean {
    const text = normalizeMessageQuotes(message.trim());
    if (messageDescribesPanelRename(text)) {
        return false;
    }
    return /\brename\b/i.test(text) && /\bdashboard\b/i.test(text);
}

function extractNewLabel(text: string): string | undefined {
    const quotedFull = text.match(/\brename\b[^.\n]{0,120}?\bto\s+"([^"]+)"/i);
    if (quotedFull?.[1]?.trim()) {
        if (quotedFull[1].includes('/')) {
            return quotedFull[1].split('/').pop()?.trim();
        }
        return quotedFull[1].trim();
    }
    const toBe = text.match(/\bto\s+be\s+([A-Za-z][A-Za-z0-9_-]*)/i);
    if (toBe?.[1]) {
        return toBe[1];
    }
    const toWord = text.match(/\brename\b[^.\n]{0,80}?\bto\s+([A-Za-z][A-Za-z0-9_-]*)/i);
    if (toWord?.[1] && !/^instead$/i.test(toWord[1])) {
        return toWord[1];
    }
    return undefined;
}

function extractReplaceLabel(text: string): string | undefined {
    const instead = text.match(/\binstead of\s+([A-Za-z][A-Za-z0-9_-]*)/i);
    if (instead?.[1]) {
        return instead[1];
    }
    const fromSlash = text.match(new RegExp(`\\b(${MACHINE_ID_PATTERN.source})\\s*/\\s*([A-Za-z][A-Za-z0-9_-]+)`, 'i'));
    if (fromSlash?.[2]) {
        return fromSlash[2];
    }
    return undefined;
}

function extractExplicitNewTitle(text: string): string | undefined {
    const m = text.match(/\brename\b[^.\n]{0,120}?\bto\s+"([^"]+)"/i);
    if (m?.[1]?.includes('/')) {
        return m[1].trim();
    }
    return undefined;
}

export function extractMachineIdForRename(message: string): string | undefined {
    const text = normalizeMessageQuotes(message.trim());
    const forMachine = text.match(
        new RegExp(`\\bfor\\s+(?:the\\s+)?(?:machine\\s+)?(${MACHINE_ID_PATTERN.source})\\b`, 'i')
    );
    if (forMachine?.[1] && isMachineId(forMachine[1])) {
        return forMachine[1];
    }
    const ids = findMachineIdsInText(text);
    return ids.find((id) => isMachineId(id));
}

export function computeRenamedDashboardTitle(
    currentTitle: string,
    opts: { machineId?: string; replaceLabel?: string; newLabel: string; newTitle?: string }
): string {
    if (opts.newTitle?.trim()) {
        return opts.newTitle.trim();
    }
    const machine = opts.machineId ?? currentTitle.split('/')[0]?.trim();
    if (opts.replaceLabel && currentTitle.toLowerCase().includes(opts.replaceLabel.toLowerCase())) {
        return currentTitle.replace(new RegExp(opts.replaceLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), opts.newLabel);
    }
    const slash = currentTitle.match(new RegExp(`^(${MACHINE_ID_PATTERN.source})\\s*/\\s*(.+)$`));
    if (slash) {
        return `${slash[1]} / ${opts.newLabel}`;
    }
    if (machine && isMachineId(machine)) {
        return `${machine} / ${opts.newLabel}`;
    }
    return `${currentTitle} / ${opts.newLabel}`.replace(/\s+\/\s+/g, ' / ');
}

export function parseDashboardRenameRequest(message: string): DashboardRenameRequest | null {
    const text = normalizeMessageQuotes(message.trim());
    if (messageDescribesPanelRename(text) || !messageDescribesDashboardRename(text)) {
        return null;
    }

    const newTitle = extractExplicitNewTitle(text);
    const newLabel = newTitle?.includes('/') ? newTitle.split('/').pop()?.trim() : extractNewLabel(text);
    if (!newLabel?.trim()) {
        return null;
    }

    const machineId = extractMachineIdForRename(text);
    const dashboardUid = extractAllDashboardUids(text)[0];
    if (!machineId && !dashboardUid) {
        return null;
    }

    return {
        machineId,
        dashboardUid,
        replaceLabel: extractReplaceLabel(text),
        newLabel: newLabel.trim(),
        newTitle,
    };
}

export function userWantsDashboardRename(message: string): boolean {
    return parseDashboardRenameRequest(message) != null;
}

export function diagnoseDashboardRenameGaps(message: string): string[] {
    const text = normalizeMessageQuotes(message.trim());
    const gaps: string[] = [];
    if (!messageDescribesDashboardRename(text)) {
        return gaps;
    }
    if (!extractMachineIdForRename(text) && extractAllDashboardUids(text).length === 0) {
        gaps.push('**Machine id** (e.g. `2505-200033`) or **dashboard uid**');
    }
    if (!extractNewLabel(text) && !extractExplicitNewTitle(text)) {
        gaps.push('**New name** (e.g. `to be NewMachine instead of Keysight`)');
    }
    return gaps;
}

export function formatDashboardRenameExamplePrompt(): string {
    return (
        'Rename the dashboard for the 2505-200033 machine to be NewMachine instead of Keysight.'
    );
}

export function formatDashboardRenameClarification(message?: string): string {
    const gaps = message ? diagnoseDashboardRenameGaps(message) : [];
    const gapBlock =
        gaps.length > 0
            ? `\n\nGraft still needs:\n${gaps.map((g) => `- ${g}`).join('\n')}\n`
            : '\n\nInclude the **machine id** (or dashboard uid) and the **new name**.\n';

    return (
        `### Need clarification\n\n` +
        `To rename a machine dashboard, say which machine and the new label after the machine id.${gapBlock}` +
        `**Example:** \`${formatDashboardRenameExamplePrompt()}\``
    );
}

export function summarizeDashboardRenameIntent(request: DashboardRenameRequest): string {
    const parts: string[] = [];
    if (request.machineId) {
        parts.push(`machine **${request.machineId}**`);
    }
    if (request.dashboardUid) {
        parts.push(`dashboard uid \`${request.dashboardUid}\``);
    }
    if (request.replaceLabel) {
        parts.push(`current label **${request.replaceLabel}**`);
    }
    parts.push(`new label **${request.newLabel}**`);
    return parts.join(', ');
}

export function formatDashboardRenameNotFoundClarification(
    request: DashboardRenameRequest,
    opts?: { searchedQueries?: string[]; nearbyTitles?: string[] }
): string {
    const understood = summarizeDashboardRenameIntent(request);
    const searched =
        opts?.searchedQueries?.length &&
        `\n\nSearched Grafana for: ${opts.searchedQueries.map((q) => `\`${q}\``).join(', ')}.`;
    const nearby =
        opts?.nearbyTitles?.length &&
        `\n\nClosest titles found:\n${opts.nearbyTitles.slice(0, 5).map((t) => `- ${t}`).join('\n')}`;

    return (
        `### Need clarification\n\n` +
        `Graft understood: rename ${understood}, but **could not find a matching dashboard** in Grafana.${searched || ''}${nearby || ''}\n\n` +
        `Please add one of:\n` +
        `- Dashboard **uid** (e.g. \`uid="abc123"\`)\n` +
        `- Exact **current title** in quotes (e.g. \`"2505-200033 / Keysight"\`)\n` +
        `- Confirm the **machine id** and old label are spelled correctly\n\n` +
        `**Example:** \`Rename dashboard uid="abc123" to be NewMachine instead of Keysight\``
    );
}

export function formatDashboardRenameAmbiguousClarification(
    request: DashboardRenameRequest,
    matches: Array<{ uid: string; title: string }>
): string {
    const understood = summarizeDashboardRenameIntent(request);
    const list = matches
        .slice(0, 8)
        .map((m) => `- **${m.title}** — uid \`${m.uid}\``)
        .join('\n');

    return (
        `### Need clarification\n\n` +
        `Graft understood: rename ${understood}, but **found multiple matching dashboards**:\n\n` +
        `${list}\n\n` +
        `Reply with the dashboard **uid** or exact title to rename.\n\n` +
        `**Example:** \`Rename dashboard uid="${matches[0]?.uid ?? 'YOUR_UID'}" to be ${request.newLabel}\``
    );
}
