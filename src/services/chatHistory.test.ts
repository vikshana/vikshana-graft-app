import {
    chatHistoryService,
    ChatSession,
    prepareMessagesForStorage,
    sessionFingerprint,
} from './chatHistory';

jest.mock('./chatHistoryApi', () => ({
    loadChatHistoryFromServer: jest.fn().mockResolvedValue(null),
    saveChatHistoryToServer: jest.fn().mockResolvedValue(true),
}));

describe('ChatHistoryService', () => {
    beforeEach(async () => {
        localStorage.clear();
        sessionStorage.clear();
        chatHistoryService.resetForTests();
        await chatHistoryService.ensureLoaded();
    });

    describe('Pinning', () => {
        it('should pin a session', () => {
            const session: ChatSession = {
                id: 'test-1',
                title: 'Test Session',
                messages: [{ role: 'user', content: 'Hello' }],
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };

            chatHistoryService.saveSession(session.messages, session.id);
            const result = chatHistoryService.togglePinSession(session.id);

            expect(result).toBe(true);
            const retrieved = chatHistoryService.getSession(session.id);
            expect(retrieved?.isPinned).toBe(true);
        });

        it('should unpin a session', () => {
            const session: ChatSession = {
                id: 'test-1',
                title: 'Test Session',
                messages: [{ role: 'user', content: 'Hello' }],
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };

            chatHistoryService.saveSession(session.messages, session.id);
            chatHistoryService.togglePinSession(session.id);
            const result = chatHistoryService.togglePinSession(session.id);

            expect(result).toBe(true);
            const retrieved = chatHistoryService.getSession(session.id);
            expect(retrieved?.isPinned).toBe(false);
        });

        it('should return false when pin limit (20) is reached', () => {
            // Create 20 sessions and pin them
            for (let i = 0; i < 20; i++) {
                const messages = [{ role: 'user' as const, content: `Message ${i}` }];
                chatHistoryService.saveSession(messages, `session-${i}`);
                chatHistoryService.togglePinSession(`session-${i}`);
            }

            // Try to pin the 21st session
            const messages = [{ role: 'user' as const, content: 'Message 21' }];
            chatHistoryService.saveSession(messages, 'session-21');
            const result = chatHistoryService.togglePinSession('session-21');

            expect(result).toBe(false);
            const retrieved = chatHistoryService.getSession('session-21');
            expect(retrieved?.isPinned).toBeFalsy();
        });

        it('should sort pinned sessions first', async () => {
            const now = Date.now();

            await seedSessions([
                { id: 'session-1', title: '1', messages: [{ role: 'user', content: 'Message for session-1' }], createdAt: now - 3000, updatedAt: now - 3000, isPinned: false },
                { id: 'session-2', title: '2', messages: [{ role: 'user', content: 'Message for session-2' }], createdAt: now - 2000, updatedAt: now - 2000, isPinned: true },
                { id: 'session-3', title: '3', messages: [{ role: 'user', content: 'Message for session-3' }], createdAt: now - 1000, updatedAt: now - 1000, isPinned: false },
                { id: 'session-4', title: '4', messages: [{ role: 'user', content: 'Message for session-4' }], createdAt: now, updatedAt: now, isPinned: true },
            ]);

            const allSessions = chatHistoryService.getAllSessions();

            // First two should be pinned
            expect(allSessions[0].isPinned).toBe(true);
            expect(allSessions[1].isPinned).toBe(true);
            // Last two should not be pinned
            expect(allSessions[2].isPinned).toBeFalsy();
            expect(allSessions[3].isPinned).toBeFalsy();

            // Pinned sessions should be sorted by updatedAt (newest first)
            expect(allSessions[0].id).toBe('session-4');
            expect(allSessions[1].id).toBe('session-2');

            // Unpinned sessions should also be sorted by updatedAt (newest first)
            expect(allSessions[2].id).toBe('session-3');
            expect(allSessions[3].id).toBe('session-1');
        });
    });

    describe('dedupeSessions', () => {
        it('merges sessions with the same first user message and turn count', () => {
            const messages = [{ role: 'user' as const, content: 'Fix dashboard panels' }];
            chatHistoryService.saveSession(messages, 'session-a');
            chatHistoryService.saveSession(messages, 'session-b');
            expect(chatHistoryService.getAllSessions()).toHaveLength(1);
            expect(chatHistoryService.getAllSessions()[0].id).toBe('session-b');
        });

        it('keeps distinct conversations with different first prompts', () => {
            chatHistoryService.saveSession([{ role: 'user', content: 'Question A' }], 'a');
            chatHistoryService.saveSession([{ role: 'user', content: 'Question B' }], 'b');
            expect(chatHistoryService.getAllSessions()).toHaveLength(2);
        });

        it('reuses last active session when saving without id after continuation', () => {
            const messages = [{ role: 'user' as const, content: 'Continue work' }];
            const first = chatHistoryService.saveSession(messages, 'session-1');
            expect(first?.id).toBe('session-1');
            const extended = [
                ...messages,
                { role: 'assistant' as const, content: 'Working on it' },
                { role: 'user' as const, content: 'Also update panel 2' },
            ];
            const second = chatHistoryService.saveSession(extended);
            expect(second?.id).toBe('session-1');
            expect(chatHistoryService.getAllSessions()).toHaveLength(1);
        });
    });

    describe('sessionFingerprint', () => {
        it('includes first user message and user turn count', () => {
            const fp = sessionFingerprint({
                id: 'x',
                title: 't',
                createdAt: 0,
                updatedAt: 0,
                messages: [
                    { role: 'user', content: 'Hello' },
                    { role: 'assistant', content: 'Hi' },
                    { role: 'user', content: 'Again' },
                ],
            });
            expect(fp).toBe('Hello|u2');
        });
    });

    describe('prepareMessagesForStorage', () => {
        it('removes trailing empty assistant placeholders', () => {
            const messages = [
                { role: 'user' as const, content: 'Hi' },
                { role: 'assistant' as const, content: '' },
            ];
            expect(prepareMessagesForStorage(messages)).toEqual([{ role: 'user', content: 'Hi' }]);
        });
    });

    describe('loadLastActiveSession', () => {
        it('returns the last saved session', () => {
            const messages = [{ role: 'user' as const, content: 'Remember' }];
            const saved = chatHistoryService.saveSession(messages);
            expect(saved).not.toBeNull();
            const loaded = chatHistoryService.loadLastActiveSession();
            expect(loaded?.sessionId).toBe(saved!.id);
            expect(loaded?.messages).toEqual(messages);
        });

        it('prefers sessionStorage snapshot for same-tab restore', () => {
            const messages = [{ role: 'user' as const, content: 'From snapshot' }];
            const saved = chatHistoryService.saveSession(messages);
            expect(saved).not.toBeNull();
            chatHistoryService.saveActiveSnapshot(saved!.id, messages);
            const loaded = chatHistoryService.loadLastActiveSession();
            expect(loaded?.messages[0].content).toBe('From snapshot');
        });

        it('returns null when saving empty messages', () => {
            expect(chatHistoryService.saveSession([])).toBeNull();
        });
    });

    describe('Last active session', () => {
        it('should track the last saved session', () => {
            const messages = [{ role: 'user' as const, content: 'Hello' }];
            const saved = chatHistoryService.saveSession(messages);
            expect(saved).not.toBeNull();

            expect(chatHistoryService.getLastActiveSessionId()).toBe(saved!.id);
        });

        it('should clear last active when session is deleted', () => {
            const messages = [{ role: 'user' as const, content: 'Hello' }];
            const saved = chatHistoryService.saveSession(messages);

            chatHistoryService.deleteSession(saved!.id);

            expect(chatHistoryService.getLastActiveSessionId()).toBeNull();
        });

        it('should clear last active via clearLastActiveSessionId', () => {
            const messages = [{ role: 'user' as const, content: 'Hello' }];
            chatHistoryService.saveSession(messages);

            chatHistoryService.clearLastActiveSessionId();

            expect(chatHistoryService.getLastActiveSessionId()).toBeNull();
        });
    });

    // The service caches sessions in memory and rewrites localStorage on every save,
    // so manual localStorage edits between service calls get clobbered. Seed the full
    // desired state into storage and reload once, then exercise the real behavior.
    async function seedSessions(seed: ChatSession[]): Promise<void> {
        localStorage.setItem('graft_chat_history', JSON.stringify(seed));
        chatHistoryService.resetForTests();
        await chatHistoryService.ensureLoaded();
    }

    describe('Cleanup', () => {
        it('should preserve pinned sessions during cleanup', async () => {
            const oldDate = Date.now() - 31 * 24 * 60 * 60 * 1000; // 31 days ago
            const now = Date.now();
            await seedSessions([
                { id: 'old-pinned', title: 'Old pinned', messages: [{ role: 'user', content: 'Old pinned' }], createdAt: oldDate, updatedAt: oldDate, isPinned: true },
                { id: 'old-unpinned', title: 'Old unpinned', messages: [{ role: 'user', content: 'Old unpinned' }], createdAt: oldDate, updatedAt: oldDate, isPinned: false },
                { id: 'recent', title: 'Recent', messages: [{ role: 'user', content: 'Recent' }], createdAt: now, updatedAt: now, isPinned: false },
            ]);

            chatHistoryService.cleanupOldSessions(50, 30);

            const allSessions = chatHistoryService.getAllSessions();

            // Should have 2 sessions: old-pinned (kept because pinned) and recent
            expect(allSessions.length).toBe(2);
            expect(allSessions.some(s => s.id === 'old-pinned')).toBe(true);
            expect(allSessions.some(s => s.id === 'recent')).toBe(true);
            expect(allSessions.some(s => s.id === 'old-unpinned')).toBe(false);
        });

        it('should remove old unpinned sessions', async () => {
            const oldDate = Date.now() - 31 * 24 * 60 * 60 * 1000;
            await seedSessions([
                { id: 'old-session', title: 'Old', messages: [{ role: 'user', content: 'Old message' }], createdAt: oldDate, updatedAt: oldDate, isPinned: false },
            ]);

            chatHistoryService.cleanupOldSessions(50, 30);

            const allSessions = chatHistoryService.getAllSessions();
            expect(allSessions.length).toBe(0);
        });

        it('should respect max history limit while preserving pinned sessions', () => {
            // Create 25 unpinned sessions
            for (let i = 0; i < 25; i++) {
                const messages = [{ role: 'user' as const, content: `Message ${i}` }];
                chatHistoryService.saveSession(messages, `session-${i}`);
            }

            // Pin 5 of them
            for (let i = 0; i < 5; i++) {
                chatHistoryService.togglePinSession(`session-${i}`);
            }

            // Clean up with max 10 sessions
            chatHistoryService.cleanupOldSessions(10, 30);

            const allSessions = chatHistoryService.getAllSessions();

            // Should have 10 sessions: 5 pinned + 5 most recent unpinned
            expect(allSessions.length).toBe(10);

            const pinnedSessions = allSessions.filter(s => s.isPinned);
            expect(pinnedSessions.length).toBe(5);
        });
    });
});
