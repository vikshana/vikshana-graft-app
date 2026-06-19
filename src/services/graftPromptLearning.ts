import { extractDashboardUidFromMessage } from './dashboardMentionParse';
import { promptLibraryService } from './promptLibrary';
import { scopedStorageKey } from './storageScope';

export type ClarificationKind = 'ambiguous-graph-create' | 'generic-clarification';

export interface PendingClarification {
    kind: ClarificationKind;
    vagueMessage: string;
    dashboardUid?: string;
    at: number;
}

export interface LearnedPrompt {
    kind: ClarificationKind;
    prompt: string;
    dashboardUid?: string;
    successCount: number;
    lastUsedAt: number;
    title: string;
}

const PENDING_KEY_BASE = 'graft_pending_clarification';
const LEARNED_KEY_BASE = 'graft_learned_prompts';
// Scope per (org, user) so learned prompts / pending clarifications never bleed
// between users or orgs sharing the same browser profile.
const PENDING_KEY = (): string => scopedStorageKey(PENDING_KEY_BASE);
const LEARNED_KEY = (): string => scopedStorageKey(LEARNED_KEY_BASE);
const MAX_LEARNED = 40;
const LEARNED_CATEGORY = 'Learned';

function readPending(): PendingClarification | null {
    if (typeof sessionStorage === 'undefined') {
        return null;
    }
    try {
        const raw = sessionStorage.getItem(PENDING_KEY());
        return raw ? (JSON.parse(raw) as PendingClarification) : null;
    } catch {
        return null;
    }
}

function writePending(value: PendingClarification | null): void {
    if (typeof sessionStorage === 'undefined') {
        return;
    }
    try {
        if (!value) {
            sessionStorage.removeItem(PENDING_KEY());
        } else {
            sessionStorage.setItem(PENDING_KEY(), JSON.stringify(value));
        }
    } catch {
        // ignore
    }
}

function readLearned(): LearnedPrompt[] {
    if (typeof localStorage === 'undefined') {
        return [];
    }
    try {
        const raw = localStorage.getItem(LEARNED_KEY());
        const parsed = raw ? (JSON.parse(raw) as LearnedPrompt[]) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function writeLearned(rows: LearnedPrompt[]): void {
    if (typeof localStorage === 'undefined') {
        return;
    }
    localStorage.setItem(LEARNED_KEY(), JSON.stringify(rows.slice(0, MAX_LEARNED)));
}

function normalizePrompt(text: string): string {
    return text.trim().replace(/\s+/g, ' ');
}

function learnedTitle(kind: ClarificationKind, prompt: string): string {
    if (kind === 'ambiguous-graph-create') {
        if (/\b50\s+panels?\b/i.test(prompt)) {
            return 'Learned: bulk metric panels';
        }
        if (/\brow\b/i.test(prompt)) {
            return 'Learned: row + panels';
        }
        if (/\bgauge\s+panel\b/i.test(prompt) && /\btime\s*series\b/i.test(prompt)) {
            return 'Learned: typed multi-panel create';
        }
        return 'Learned: Keysight graphs';
    }
    const short = prompt.slice(0, 48).trim();
    return short.length < prompt.length ? `Learned: ${short}…` : `Learned: ${short}`;
}

function promptsMatch(a: string, b: string): boolean {
    return normalizePrompt(a).toLowerCase() === normalizePrompt(b).toLowerCase();
}

/** Remember that Graft just asked for clarification on a vague operator prompt. */
export function recordClarificationShown(
    kind: ClarificationKind,
    vagueMessage: string,
    dashboardUid?: string
): void {
    const text = vagueMessage.trim();
    if (!text) {
        return;
    }
    writePending({
        kind,
        vagueMessage: text.slice(0, 2000),
        dashboardUid: dashboardUid ?? extractDashboardUidFromMessage(text),
        at: Date.now(),
    });
}

export function clearPendingClarification(): void {
    writePending(null);
}

export function getPendingClarification(): PendingClarification | null {
    return readPending();
}

export function getLearnedPromptsForKind(
    kind: ClarificationKind,
    dashboardUid?: string,
    limit = 3
): LearnedPrompt[] {
    const rows = readLearned().filter((r) => r.kind === kind);
    const uid = dashboardUid?.trim();
    const scored = rows
        .map((r) => {
            let score = r.successCount;
            if (uid && r.dashboardUid === uid) {
                score += 5;
            }
            score += Math.max(0, 3 - (Date.now() - r.lastUsedAt) / 86_400_000);
            return { r, score };
        })
        .sort((a, b) => b.score - a.score || b.r.lastUsedAt - a.r.lastUsedAt);
    return scored.slice(0, limit).map((s) => s.r);
}

export function appendLearnedPromptHints(
    clarification: string,
    kind: ClarificationKind,
    dashboardUid?: string
): string {
    const learned = getLearnedPromptsForKind(kind, dashboardUid);
    if (learned.length === 0) {
        return clarification;
    }
    const lines = learned.map(
        (r) =>
            `- (${r.successCount}×) \`${r.prompt.length > 120 ? `${r.prompt.slice(0, 117)}…` : r.prompt}\``
    );
    return (
        `${clarification.trim()}\n\n` +
        `**Worked for you before** (saved to Prompt Library → **${LEARNED_CATEGORY}**):\n` +
        `${lines.join('\n')}\n`
    );
}

function upsertLearnedPrompt(
    row: Omit<LearnedPrompt, 'successCount' | 'lastUsedAt'> & { successCount?: number }
): LearnedPrompt {
    const existing = readLearned();
    const idx = existing.findIndex(
        (r) => r.kind === row.kind && promptsMatch(r.prompt, row.prompt) && r.dashboardUid === row.dashboardUid
    );
    const now = Date.now();
    let saved: LearnedPrompt;
    if (idx >= 0) {
        saved = {
            ...existing[idx],
            successCount: existing[idx].successCount + 1,
            lastUsedAt: now,
            title: row.title,
        };
        existing[idx] = saved;
    } else {
        saved = {
            ...row,
            successCount: row.successCount ?? 1,
            lastUsedAt: now,
        };
        existing.unshift(saved);
    }
    writeLearned(existing);
    return saved;
}

export function formatLearnedSuccessNote(learned: LearnedPrompt | null): string {
    if (!learned) {
        return '';
    }
    return (
        `\n\n_Graft saved this prompt under **Prompt Library → ${LEARNED_CATEGORY}** ` +
        `(${learned.successCount}× success). Next time a similar vague request will suggest it first._`
    );
}

function saveToPromptLibrary(learned: LearnedPrompt): void {
    const prompts = promptLibraryService.getUserPrompts();
    const duplicate = prompts.some((p) => promptsMatch(p.content, learned.prompt));
    if (duplicate) {
        return;
    }
    promptLibraryService.saveUserPrompt({
        title: learned.title,
        content: learned.prompt,
        category: LEARNED_CATEGORY,
    });
}

/**
 * After a programmatic success, learn the operator's follow-up if it resolved a prior clarification.
 */
export function tryLearnFromProgrammaticSuccess(opts: {
    userMessage: string;
    intent: string;
    dashboardUid?: string;
}): LearnedPrompt | null {
    const pending = readPending();
    const prompt = normalizePrompt(opts.userMessage);
    if (!pending || !prompt) {
        return null;
    }
    if (promptsMatch(prompt, pending.vagueMessage)) {
        return null;
    }

    const learned = upsertLearnedPrompt({
        kind: pending.kind,
        prompt,
        dashboardUid: opts.dashboardUid ?? pending.dashboardUid ?? extractDashboardUidFromMessage(prompt),
        title: learnedTitle(pending.kind, prompt),
    });
    saveToPromptLibrary(learned);
    clearPendingClarification();
    return learned;
}

export function listLearnedPrompts(): LearnedPrompt[] {
    return readLearned();
}

/** Test helper */
export function clearLearnedPromptsForTests(): void {
    writeLearned([]);
    clearPendingClarification();
}
