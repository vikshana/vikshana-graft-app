// Import types from centralized location
import { config } from '@grafana/runtime';
import type { Message } from '../types/llm.types';
import type { ChatSession } from '../types/chat.types';
import { loadChatHistoryFromServer, saveChatHistoryToServer } from './chatHistoryApi';
import { getStorageSuffix, scopedStorageKey as storageKey } from './storageScope';

// Re-export for backward compatibility
export type { ChatSession };

const STORAGE_KEY_BASE = 'graft_chat_history';
const LAST_ACTIVE_SESSION_KEY_BASE = 'graft_last_active_session';
const ACTIVE_SNAPSHOT_KEY_BASE = 'graft_active_snapshot';
const DEFAULT_MAX_HISTORY = 50;
const DEFAULT_RETENTION_DAYS = 30;
const MAX_PINNED_SESSIONS = 20;
const GLOBAL_SERVICE_KEY = '__vikshanaGraftChatHistoryService';

/** Drop trailing empty assistant placeholders so mid-stream navigation still restores user turns. */
export function prepareMessagesForStorage(messages: Message[]): Message[] {
    const copy = [...messages];
    while (copy.length > 0) {
        const last = copy[copy.length - 1];
        const emptyAssistant =
            last.role === 'assistant' &&
            !last.content?.trim() &&
            !(last.toolExecutions && last.toolExecutions.length > 0);
        if (emptyAssistant) {
            copy.pop();
        } else {
            break;
        }
    }
    return copy;
}

function serializeMessages(messages: Message[]): Message[] {
    return prepareMessagesForStorage(messages).map((m) => {
        const base: Message = {
            role: m.role,
            content: m.content,
        };
        if (m.attachments?.length) {
            base.attachments = m.attachments.map((a) => ({
                name: a.name,
                type: a.type,
                mimeType: a.mimeType,
                content: a.content,
            }));
        }
        if (m.toolExecutions?.length) {
            base.toolExecutions = m.toolExecutions.map((t) => ({
                name: t.name,
                status: t.status,
                error: t.error,
                toolCallId: t.toolCallId,
                summary: t.summary,
                userReference: t.userReference,
            }));
        }
        if (m.thinkingSeconds !== undefined) {
            base.thinkingSeconds = m.thinkingSeconds;
        }
        if (m.interrupted) {
            base.interrupted = m.interrupted;
        }
        return base;
    });
}

export interface ActiveSnapshot {
    sessionId: string;
    messages: Message[];
    updatedAt: number;
}

class ChatHistoryService {
    private legacyMigrated = false;
    private loaded = false;
    private loadPromise: Promise<void> | null = null;
    private saveTimer: ReturnType<typeof setTimeout> | null = null;
    private sessions: ChatSession[] = [];
    private lastActiveSessionId: string | null = null;

    /** Load history from plugin backend (and migrate browser storage once). */
    ensureLoaded(): Promise<void> {
        if (this.loaded) {
            return Promise.resolve();
        }
        if (!this.loadPromise) {
            this.loadPromise = this.hydrateFromStorage();
        }
        return this.loadPromise;
    }

    /**
     * Re-sync from localStorage and server (for Previous Conversations page).
     * Lazy-loaded chunks can hold a stale in-memory copy; localStorage is shared.
     */
    async refreshSessions(): Promise<void> {
        await this.ensureLoaded();

        const fromLocal = this.readLocalBundle();
        if (fromLocal.sessions.length > 0) {
            this.mergeSessions(fromLocal.sessions);
            if (fromLocal.lastActiveId) {
                this.lastActiveSessionId = fromLocal.lastActiveId;
            }
        }

        const fromServer = await loadChatHistoryFromServer();
        if (fromServer?.sessions?.length) {
            this.mergeSessions(fromServer.sessions);
            if (fromServer.lastActiveSessionId) {
                this.lastActiveSessionId = fromServer.lastActiveSessionId;
            }
        }

        this.writeLocalBundle();
        this.loaded = true;
    }

    private mergeSessions(incoming: ChatSession[]): void {
        const byId = new Map(this.sessions.map((s) => [s.id, s]));
        for (const session of incoming) {
            if (!session?.id) {
                continue;
            }
            const existing = byId.get(session.id);
            if (!existing || session.updatedAt >= existing.updatedAt) {
                byId.set(session.id, session);
            }
        }
        this.sessions = Array.from(byId.values());
        this.dedupeSessions();
    }

    /** Collapse duplicate rows (race saves / dual localStorage keys / server merge). */
    dedupeSessions(): void {
        const byFingerprint = new Map<string, ChatSession>();
        for (const session of this.sessions) {
            if (!session?.id || !session.messages?.length) {
                continue;
            }
            const fp = sessionFingerprint(session);
            const existing = byFingerprint.get(fp);
            if (!existing || session.updatedAt >= existing.updatedAt) {
                byFingerprint.set(fp, session);
            }
        }
        const kept = Array.from(byFingerprint.values());
        const keptIds = new Set(kept.map((s) => s.id));
        if (this.lastActiveSessionId && !keptIds.has(this.lastActiveSessionId)) {
            const evicted = this.sessions.find((s) => s.id === this.lastActiveSessionId);
            const fp = evicted?.messages?.length ? sessionFingerprint(evicted) : null;
            const replacement = fp ? kept.find((s) => sessionFingerprint(s) === fp) : undefined;
            this.lastActiveSessionId =
                replacement?.id ?? kept.sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id ?? null;
        }
        this.sessions = kept;
    }

    /** Push in-memory state to the plugin backend immediately. */
    async flushToServer(): Promise<void> {
        if (!this.loaded) {
            await this.ensureLoaded();
        }
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        await saveChatHistoryToServer({
            sessions: this.sessions,
            lastActiveSessionId: this.lastActiveSessionId,
        });
    }

    /** @internal */
    resetForTests(): void {
        this.loaded = false;
        this.loadPromise = null;
        this.sessions = [];
        this.lastActiveSessionId = null;
        this.legacyMigrated = false;
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
    }

    private async hydrateFromStorage(): Promise<void> {
        this.migrateLegacyKeys();

        const fromServer = await loadChatHistoryFromServer();
        const fromLocal = this.readLocalBundle();

        if (fromServer && fromServer.sessions.length > 0) {
            this.sessions = fromServer.sessions;
            this.lastActiveSessionId = fromServer.lastActiveSessionId;
        } else if (fromLocal.sessions.length > 0) {
            this.sessions = fromLocal.sessions;
            this.lastActiveSessionId = fromLocal.lastActiveId;
            await saveChatHistoryToServer({
                sessions: this.sessions,
                lastActiveSessionId: this.lastActiveSessionId,
            });
        } else {
            this.sessions = [];
            this.lastActiveSessionId = null;
        }

        this.dedupeSessions();
        this.writeLocalBundle();
        if (this.sessions.length > 0) {
            void saveChatHistoryToServer({
                sessions: this.sessions,
                lastActiveSessionId: this.lastActiveSessionId,
            });
        }
        this.loaded = true;
    }

    private readJson<T>(key: string): T | null {
        try {
            const stored = localStorage.getItem(key);
            return stored ? (JSON.parse(stored) as T) : null;
        } catch {
            return null;
        }
    }

    private readLocalBundle(): { sessions: ChatSession[]; lastActiveId: string | null } {
        // Read ONLY the current user's scoped key. The bare base key is global and
        // unattributable, so for a logged-in user we never merge it (cross-user leak).
        const historyKey = storageKey(STORAGE_KEY_BASE);
        const sessions = this.readJson<ChatSession[]>(historyKey) ?? [];
        const lastActiveId = localStorage.getItem(storageKey(LAST_ACTIVE_SESSION_KEY_BASE));
        return { sessions, lastActiveId };
    }

    private writeLocalBundle(): void {
        // Write ONLY the current user's scoped key — never a global/un-suffixed copy.
        const historyKey = storageKey(STORAGE_KEY_BASE);
        const lastKey = storageKey(LAST_ACTIVE_SESSION_KEY_BASE);
        try {
            const data = JSON.stringify(this.sessions);
            localStorage.setItem(historyKey, data);
            if (this.lastActiveSessionId) {
                localStorage.setItem(lastKey, this.lastActiveSessionId);
            }
        } catch (e) {
            console.error('[Graft] Error writing local chat history cache:', e);
        }
    }

    private scheduleServerSave(): void {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
        }
        this.saveTimer = setTimeout(() => {
            void saveChatHistoryToServer({
                sessions: this.sessions,
                lastActiveSessionId: this.lastActiveSessionId,
            });
        }, 400);
    }

    private persist(): void {
        this.writeLocalBundle();
        this.scheduleServerSave();
    }

    private migrateLegacyKeys(): void {
        if (this.legacyMigrated) {
            return;
        }

        const historyKey = storageKey(STORAGE_KEY_BASE);

        try {
            // Migrate ONLY from the older per-identity key (orgId_id). The bare
            // un-suffixed key is global/unattributable and is intentionally NOT
            // migrated, to avoid leaking a previous user's history on a shared browser.
            const suffix = getStorageSuffix();
            if (suffix !== 'default') {
                const user = config.bootData?.user;
                if (user?.id != null && user.orgId != null) {
                    const oldKey = `${STORAGE_KEY_BASE}_${user.orgId}_${user.id}`;
                    if (oldKey !== historyKey) {
                        const oldData = this.readJson<ChatSession[]>(oldKey);
                        if (oldData?.length && !this.readJson<ChatSession[]>(historyKey)?.length) {
                            localStorage.setItem(historyKey, JSON.stringify(oldData));
                        }
                    }
                }
                // A real user is in context, so the bare global keys are stale and
                // unattributable. Delete them so a previous user's history / last-active
                // pointer can't linger in a shared browser profile.
                localStorage.removeItem(STORAGE_KEY_BASE);
                localStorage.removeItem(LAST_ACTIVE_SESSION_KEY_BASE);
                localStorage.removeItem(ACTIVE_SNAPSHOT_KEY_BASE);
            }
        } catch (e) {
            console.error('[Graft] Error migrating chat history keys:', e);
        }

        this.legacyMigrated = true;
    }

    private generateId(): string {
        return `chat_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    }

    private generateTitle(messages: Message[]): string {
        const firstUserMessage = messages.find((m) => m.role === 'user');
        if (firstUserMessage) {
            const content = firstUserMessage.content.trim();
            return content.length > 50 ? content.substring(0, 47) + '...' : content;
        }
        return 'New Chat';
    }

    getAllSessions(): ChatSession[] {
        return [...this.sessions].sort((a, b) => {
            if (a.isPinned && !b.isPinned) {
                return -1;
            }
            if (!a.isPinned && b.isPinned) {
                return 1;
            }
            return b.updatedAt - a.updatedAt;
        });
    }

    getSession(id: string): ChatSession | undefined {
        return this.sessions.find((s) => s.id === id);
    }

    getLastActiveSessionId(): string | null {
        return this.lastActiveSessionId;
    }

    setLastActiveSessionId(id: string): void {
        this.lastActiveSessionId = id;
        this.persist();
    }

    clearLastActiveSessionId(): void {
        this.lastActiveSessionId = null;
        try {
            localStorage.removeItem(storageKey(LAST_ACTIVE_SESSION_KEY_BASE));
            sessionStorage.removeItem(storageKey(ACTIVE_SNAPSHOT_KEY_BASE));
            // Best-effort cleanup of any pre-existing global copies from older builds.
            localStorage.removeItem(LAST_ACTIVE_SESSION_KEY_BASE);
            sessionStorage.removeItem(ACTIVE_SNAPSHOT_KEY_BASE);
        } catch (e) {
            console.error('[Graft] Error clearing last active session:', e);
        }
        this.scheduleServerSave();
    }

    /** Fast restore when returning from a dashboard in the same browser tab. */
    saveActiveSnapshot(sessionId: string, messages: Message[]): void {
        const toStore = serializeMessages(messages);
        if (toStore.length === 0) {
            return;
        }
        const snap: ActiveSnapshot = {
            sessionId,
            messages: toStore,
            updatedAt: Date.now(),
        };
        try {
            const key = storageKey(ACTIVE_SNAPSHOT_KEY_BASE);
            const data = JSON.stringify(snap);
            sessionStorage.setItem(key, data);
        } catch (e) {
            console.error('[Graft] Error saving active snapshot:', e);
        }
    }

    loadActiveSnapshot(): ActiveSnapshot | null {
        try {
            const key = storageKey(ACTIVE_SNAPSHOT_KEY_BASE);
            const raw = sessionStorage.getItem(key);
            if (!raw) {
                return null;
            }
            const snap = JSON.parse(raw) as ActiveSnapshot;
            if (!snap?.sessionId || !snap.messages?.length) {
                return null;
            }
            return snap;
        } catch (e) {
            console.error('[Graft] Error loading active snapshot:', e);
            return null;
        }
    }

    /** Restore the conversation the user had open when they left the app. */
    loadLastActiveSession(): { sessionId: string; messages: Message[] } | null {
        const snap = this.loadActiveSnapshot();
        if (snap) {
            return { sessionId: snap.sessionId, messages: snap.messages };
        }

        const lastId = this.getLastActiveSessionId();
        if (!lastId) {
            return null;
        }
        const session = this.getSession(lastId);
        if (!session?.messages?.length) {
            return null;
        }
        return { sessionId: session.id, messages: session.messages };
    }

    togglePinSession(id: string): boolean {
        const session = this.sessions.find((s) => s.id === id);

        if (!session) {
            return false;
        }

        if (!session.isPinned) {
            const pinnedCount = this.sessions.filter((s) => s.isPinned).length;
            if (pinnedCount >= MAX_PINNED_SESSIONS) {
                return false;
            }
            session.isPinned = true;
        } else {
            session.isPinned = false;
        }

        this.persist();
        return true;
    }

    saveSession(messages: Message[], sessionId?: string): ChatSession | null {
        const toStore = serializeMessages(messages);
        if (toStore.length === 0) {
            return null;
        }

        let resolvedId = sessionId;
        if (!resolvedId && this.lastActiveSessionId) {
            const active = this.getSession(this.lastActiveSessionId);
            if (active && isSameConversation(active.messages, toStore)) {
                resolvedId = active.id;
            }
        }

        const now = Date.now();
        let session: ChatSession;

        if (resolvedId) {
            const existing = this.sessions.find((s) => s.id === resolvedId);
            if (existing) {
                existing.messages = toStore;
                existing.updatedAt = now;
                existing.title = this.generateTitle(toStore);
                session = existing;
            } else {
                session = {
                    id: resolvedId,
                    title: this.generateTitle(toStore),
                    messages: toStore,
                    createdAt: now,
                    updatedAt: now,
                };
                this.sessions.push(session);
            }
        } else {
            session = {
                id: this.generateId(),
                title: this.generateTitle(toStore),
                messages: toStore,
                createdAt: now,
                updatedAt: now,
            };
            this.sessions.push(session);
        }

        this.lastActiveSessionId = session.id;
        this.saveActiveSnapshot(session.id, toStore);
        this.dedupeSessions();
        this.persist();
        return session;
    }

    deleteSession(id: string): void {
        this.sessions = this.sessions.filter((s) => s.id !== id);
        if (this.lastActiveSessionId === id) {
            this.lastActiveSessionId = null;
        }
        this.persist();
    }

    cleanupOldSessions(maxHistory: number = DEFAULT_MAX_HISTORY, retentionDays: number = DEFAULT_RETENTION_DAYS): void {
        const cutoffTime = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
        let sessions = this.sessions.filter((s) => s.isPinned || s.createdAt > cutoffTime);

        const pinnedSessions = sessions.filter((s) => s.isPinned);
        let unpinnedSessions = sessions.filter((s) => !s.isPinned);

        if (unpinnedSessions.length + pinnedSessions.length > maxHistory) {
            const availableSlots = Math.max(0, maxHistory - pinnedSessions.length);
            unpinnedSessions = unpinnedSessions.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, availableSlots);
        }

        this.sessions = [...pinnedSessions, ...unpinnedSessions];
        this.persist();
    }

    clearAll(): void {
        this.sessions = [];
        this.lastActiveSessionId = null;
        localStorage.removeItem(storageKey(STORAGE_KEY_BASE));
        localStorage.removeItem(STORAGE_KEY_BASE);
        this.clearLastActiveSessionId();
        void saveChatHistoryToServer({ sessions: [], lastActiveSessionId: null });
    }
}

function getOrCreateChatHistoryService(): ChatHistoryService {
    const g = globalThis as unknown as Record<string, ChatHistoryService | undefined>;
    if (!g[GLOBAL_SERVICE_KEY]) {
        g[GLOBAL_SERVICE_KEY] = new ChatHistoryService();
    }
    return g[GLOBAL_SERVICE_KEY];
}

/** Single instance across lazy-loaded chunks (ChatInterface vs ChatHistory). */
export const chatHistoryService = getOrCreateChatHistoryService();

/** Exported for unit tests. */
export function sessionFingerprint(session: ChatSession): string {
    const firstUser = session.messages.find((m) => m.role === 'user');
    if (!firstUser?.content?.trim()) {
        return `id:${session.id}`;
    }
    const preview = firstUser.content.trim().slice(0, 120);
    const userTurns = session.messages.filter((m) => m.role === 'user').length;
    return `${preview}|u${userTurns}`;
}

function isSameConversation(stored: Message[], incoming: Message[]): boolean {
    const a = prepareMessagesForStorage(stored);
    const b = prepareMessagesForStorage(incoming);
    if (a.length === 0 || b.length === 0) {
        return false;
    }
    const firstA = a.find((m) => m.role === 'user');
    const firstB = b.find((m) => m.role === 'user');
    if (!firstA || !firstB || firstA.content.trim() !== firstB.content.trim()) {
        return false;
    }
    if (b.length < a.length) {
        return false;
    }
    for (let i = 0; i < a.length; i++) {
        if (a[i].role !== b[i].role || a[i].content !== b[i].content) {
            return false;
        }
    }
    return true;
}
