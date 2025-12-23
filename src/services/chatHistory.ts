// Import types from centralized location
import type { Message } from '../types/llm.types';
import type { ChatSession } from '../types/chat.types';

// Re-export for backward compatibility
export type { ChatSession };

const STORAGE_KEY = 'graft_chat_history';
const DEFAULT_MAX_HISTORY = 50;
const DEFAULT_RETENTION_DAYS = 30;
const MAX_PINNED_SESSIONS = 20;

class ChatHistoryService {
    private getStoredSessions(): ChatSession[] {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            return stored ? JSON.parse(stored) : [];
        } catch (e) {
            console.error('[Graft] Error loading chat history:', e);
            return [];
        }
    }

    private saveSessions(sessions: ChatSession[]): void {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
        } catch (e) {
            console.error('[Graft] Error saving chat history:', e);
        }
    }

    private generateId(): string {
        return `chat_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    }

    private generateTitle(messages: Message[]): string {
        const firstUserMessage = messages.find(m => m.role === 'user');
        if (firstUserMessage) {
            const content = firstUserMessage.content.trim();
            return content.length > 50 ? content.substring(0, 47) + '...' : content;
        }
        return 'New Chat';
    }

    getAllSessions(): ChatSession[] {
        return this.getStoredSessions().sort((a, b) => {
            // Pinned sessions come first
            if (a.isPinned && !b.isPinned) {
                return -1;
            }
            if (!a.isPinned && b.isPinned) {
                return 1;
            }
            // Then sort by updatedAt (newest first)
            return b.updatedAt - a.updatedAt;
        });
    }

    getSession(id: string): ChatSession | undefined {
        return this.getStoredSessions().find(s => s.id === id);
    }

    togglePinSession(id: string): boolean {
        const sessions = this.getStoredSessions();
        const session = sessions.find(s => s.id === id);

        if (!session) {
            return false;
        }

        if (!session.isPinned) {
            // Check limit before pinning
            const pinnedCount = sessions.filter(s => s.isPinned).length;
            if (pinnedCount >= MAX_PINNED_SESSIONS) {
                return false;
            }
            session.isPinned = true;
        } else {
            session.isPinned = false;
        }

        this.saveSessions(sessions);
        return true;
    }

    saveSession(messages: Message[], sessionId?: string): ChatSession {
        const sessions = this.getStoredSessions();
        const now = Date.now();

        let session: ChatSession;

        if (sessionId) {
            const existing = sessions.find(s => s.id === sessionId);
            if (existing) {
                existing.messages = messages;
                existing.updatedAt = now;
                existing.title = this.generateTitle(messages);
                session = existing;
            } else {
                session = {
                    id: sessionId,
                    title: this.generateTitle(messages),
                    messages,
                    createdAt: now,
                    updatedAt: now,
                };
                sessions.push(session);
            }
        } else {
            session = {
                id: this.generateId(),
                title: this.generateTitle(messages),
                messages,
                createdAt: now,
                updatedAt: now,
            };
            sessions.push(session);
        }

        this.saveSessions(sessions);
        return session;
    }

    deleteSession(id: string): void {
        const sessions = this.getStoredSessions().filter(s => s.id !== id);
        this.saveSessions(sessions);
    }

    cleanupOldSessions(maxHistory: number = DEFAULT_MAX_HISTORY, retentionDays: number = DEFAULT_RETENTION_DAYS): void {
        let sessions = this.getStoredSessions();

        // Remove sessions older than retention period, but keep pinned ones
        const cutoffTime = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
        sessions = sessions.filter(s => s.isPinned || s.createdAt > cutoffTime);

        // Keep only the most recent sessions up to maxHistory, but always keep pinned ones
        // Note: This logic might need refinement if pinned sessions exceed maxHistory, 
        // but for now we'll assume maxHistory > MAX_PINNED_SESSIONS.
        // We'll separate pinned and unpinned for cleanup.

        const pinnedSessions = sessions.filter(s => s.isPinned);
        let unpinnedSessions = sessions.filter(s => !s.isPinned);

        if (unpinnedSessions.length + pinnedSessions.length > maxHistory) {
            const availableSlots = Math.max(0, maxHistory - pinnedSessions.length);
            unpinnedSessions = unpinnedSessions.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, availableSlots);
        }

        sessions = [...pinnedSessions, ...unpinnedSessions];

        this.saveSessions(sessions);
    }

    clearAll(): void {
        localStorage.removeItem(STORAGE_KEY);
    }
}

export const chatHistoryService = new ChatHistoryService();
