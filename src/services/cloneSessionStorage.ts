import { getEffectiveCloneFieldsFromIntent, isMachineId, parseCloneIntentMessage } from './dashboardCloneParse';
import { scopedStorageKey } from './storageScope';

// Scoped per (org, user) so an in-progress clone job never carries across an
// in-tab org switch or between users sharing a browser profile.
const CLONE_INTENT_KEY = (): string => scopedStorageKey('graft_active_clone_intent');
const CLONE_META_KEY = (): string => scopedStorageKey('graft_clone_session_meta');

export interface CloneSessionMeta {
    intent: string;
    requestedTitle?: string;
    requestedMachine?: string;
    sourceMachineId?: string;
    sourceUid?: string;
    sourceTitle?: string;
    targetUid?: string;
    continueAttempts: number;
    /** Times we showed "not saved yet" without a successful save (for stuck detection). */
    notStartedStreak?: number;
    /** Chunked clone: index of next panel chunk to write (0 = not started). */
    cloneChunkIndex?: number;
    /** Chunked clone: total panel chunks for this job. */
    cloneTotalChunks?: number;
    /** Top-level panel slots in source template. */
    cloneSourcePanelSlots?: number;
    /** Top-level panel slots saved on target so far. */
    cloneTargetPanelSlotsSaved?: number;
}

function readMeta(): CloneSessionMeta | null {
    try {
        const raw = sessionStorage.getItem(CLONE_META_KEY());
        if (!raw) {
            return null;
        }
        return JSON.parse(raw) as CloneSessionMeta;
    } catch {
        return null;
    }
}

function writeMeta(meta: CloneSessionMeta): void {
    try {
        sessionStorage.setItem(CLONE_META_KEY(), JSON.stringify(meta));
    } catch {
        // ignore
    }
}

export function setActiveCloneIntent(intent: string): void {
    const trimmed = intent.trim();
    try {
        sessionStorage.setItem(CLONE_INTENT_KEY(), trimmed);
    } catch {
        // ignore
    }

    const parsed = parseCloneIntentMessage(trimmed);

    writeMeta({
        intent: trimmed,
        requestedTitle: parsed.requestedTitle,
        requestedMachine: parsed.targetMachineId,
        sourceMachineId: parsed.sourceMachineId,
        continueAttempts: 0,
        notStartedStreak: 0,
        cloneChunkIndex: 0,
        cloneTotalChunks: undefined,
    });
}

export function clearCloneChunkProgress(): void {
    const meta = readMeta();
    if (!meta) {
        return;
    }
    delete meta.cloneChunkIndex;
    delete meta.cloneTotalChunks;
    writeMeta(meta);
}

export function recordCloneNotStartedResponse(): number {
    const meta = readMeta() ?? { intent: getActiveCloneIntent() ?? '', continueAttempts: 0 };
    meta.notStartedStreak = (meta.notStartedStreak ?? 0) + 1;
    writeMeta(meta);
    return meta.notStartedStreak;
}

export function clearCloneNotStartedStreak(): void {
    const meta = readMeta();
    if (!meta) {
        return;
    }
    meta.notStartedStreak = 0;
    writeMeta(meta);
}

export function getActiveCloneIntent(): string | undefined {
    try {
        const v = sessionStorage.getItem(CLONE_INTENT_KEY())?.trim();
        return v || undefined;
    } catch {
        return undefined;
    }
}

/** Re-parse stored intent so stale values like requestedMachine "from" never persist. */
export function refreshCloneSessionFromIntent(): CloneSessionMeta | null {
    const meta = readMeta();
    const intent = meta?.intent ?? getActiveCloneIntent();
    if (!intent) {
        return meta;
    }
    const effective = getEffectiveCloneFieldsFromIntent(intent);
    const next: CloneSessionMeta = {
        ...(meta ?? { intent, continueAttempts: 0 }),
        intent,
        requestedTitle: effective.requestedTitle ?? meta?.requestedTitle,
        requestedMachine: effective.requestedMachine,
        sourceMachineId: effective.sourceMachineId ?? meta?.sourceMachineId,
    };
    if (next.requestedMachine && !isMachineId(next.requestedMachine)) {
        delete next.requestedMachine;
    }
    writeMeta(next);
    return next;
}

export function getCloneSessionMeta(): CloneSessionMeta | null {
    return refreshCloneSessionFromIntent();
}

export function recordCloneContinueAttempt(): number {
    const meta = refreshCloneSessionFromIntent() ?? {
        intent: getActiveCloneIntent() ?? '',
        continueAttempts: 0,
    };
    meta.continueAttempts += 1;
    writeMeta(meta);
    return meta.continueAttempts;
}

export function updateCloneSessionMeta(patch: Partial<CloneSessionMeta>): void {
    const existing =
        readMeta() ??
        ({
            intent: getActiveCloneIntent() ?? '',
            continueAttempts: 0,
        } as CloneSessionMeta);
    writeMeta({ ...existing, ...patch });
}

export function clearActiveCloneIntent(): void {
    try {
        sessionStorage.removeItem(CLONE_INTENT_KEY());
        sessionStorage.removeItem(CLONE_META_KEY());
    } catch {
        // ignore
    }
}

/** LLM-only message: forces save on Continue (never shown in chat bubble). */
export function buildForcedCloneContinueLlmMessage(meta: CloneSessionMeta): string {
    const effective = getEffectiveCloneFieldsFromIntent(meta.intent);
    const title =
        effective.requestedTitle ?? meta.requestedTitle ?? '2505-200033 / GlenTest';
    const targetMachine =
        effective.requestedMachine ?? meta.requestedMachine ?? '2505-200033';
    const sourceMachine =
        effective.sourceMachineId ?? meta.sourceMachineId ?? '2103-176030';
    const sourceUid = meta.sourceUid ?? 'idHkqdqnk';
    const chunkNote =
        meta.cloneChunkIndex != null &&
        meta.cloneTotalChunks != null &&
        meta.cloneChunkIndex < meta.cloneTotalChunks
            ? `\nResume panel batch ${meta.cloneChunkIndex + 1}/${meta.cloneTotalChunks} (target uid=${meta.targetUid ?? 'from search'}).\n`
            : '\n';

    return (
        `Continue — MANDATORY save step for dashboard clone.\n\n` +
        `Original request: ${meta.intent}\n${chunkNote}` +
        `Required actions THIS turn (do not stop after lookup or summary):\n` +
        `1. get_dashboard_by_uid uid=${sourceUid} (template ${sourceMachine})\n` +
        `2. search_dashboards for "${title}"\n` +
        `3. Build dashboard JSON: copy all panels from step 1, title "${title}", ` +
        `replace every Prometheus/Loki machine label ${sourceMachine} → ${targetMachine}\n` +
        `4. update_dashboard — if step 2 found a dashboard use its uid+version; otherwise create new. ` +
        `Must return uid and version.\n\n` +
        `Forbidden: ending after get_dashboard_summary only; asking the user questions; panel index tables in reply.`
    );
}

export function countContinueMessages(recentUserMessages: string[]): number {
    return recentUserMessages.filter((m) => /^continue\.?$/i.test(m.trim())).length;
}

export function normalizeUserMessageForDisplay(content: string): string {
    const t = content.trim();
    if (/^continue\.?$/i.test(t)) {
        return 'Continue';
    }
    if (/^continue the previous task\b/i.test(t)) {
        return 'Continue';
    }
    if (/^continue\.\s*finish the dashboard clone\b/i.test(t)) {
        return 'Continue';
    }
    if (/^continue\s*—\s*mandatory/i.test(t)) {
        return 'Continue';
    }
    return content;
}
