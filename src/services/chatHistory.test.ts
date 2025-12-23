import { chatHistoryService, ChatSession } from './chatHistory';

describe('ChatHistoryService', () => {
    beforeEach(() => {
        // Clear localStorage before each test
        localStorage.clear();
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

        it('should sort pinned sessions first', () => {
            const now = Date.now();

            // Create sessions with different timestamps
            const sessions = [
                { id: 'session-1', updatedAt: now - 3000, isPinned: false },
                { id: 'session-2', updatedAt: now - 2000, isPinned: true },
                { id: 'session-3', updatedAt: now - 1000, isPinned: false },
                { id: 'session-4', updatedAt: now, isPinned: true },
            ];

            sessions.forEach((s) => {
                const messages = [{ role: 'user' as const, content: `Message for ${s.id}` }];
                chatHistoryService.saveSession(messages, s.id);
                if (s.isPinned) {
                    chatHistoryService.togglePinSession(s.id);
                }
            });

            // Manually update timestamps in localStorage to match test expectations
            // because saveSession overwrites them with Date.now()
            const storedSessions = JSON.parse(localStorage.getItem('graft_chat_history') || '[]');
            storedSessions.forEach((s: any) => {
                const target = sessions.find(session => session.id === s.id);
                if (target) {
                    s.updatedAt = target.updatedAt;
                }
            });
            localStorage.setItem('graft_chat_history', JSON.stringify(storedSessions));

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

    describe('Cleanup', () => {
        it('should preserve pinned sessions during cleanup', () => {
            const oldDate = Date.now() - (31 * 24 * 60 * 60 * 1000); // 31 days ago

            // Create old pinned session
            const oldPinnedMessages = [{ role: 'user' as const, content: 'Old pinned' }];
            chatHistoryService.saveSession(oldPinnedMessages, 'old-pinned');

            // Manually set old date
            const sessions = JSON.parse(localStorage.getItem('graft_chat_history') || '[]');
            sessions[0].createdAt = oldDate;
            localStorage.setItem('graft_chat_history', JSON.stringify(sessions));

            chatHistoryService.togglePinSession('old-pinned');

            // Create old unpinned session
            const oldUnpinnedMessages = [{ role: 'user' as const, content: 'Old unpinned' }];
            chatHistoryService.saveSession(oldUnpinnedMessages, 'old-unpinned');

            // Manually set old date
            const sessions2 = JSON.parse(localStorage.getItem('graft_chat_history') || '[]');
            sessions2[1].createdAt = oldDate;
            localStorage.setItem('graft_chat_history', JSON.stringify(sessions2));

            // Create recent session
            const recentMessages = [{ role: 'user' as const, content: 'Recent' }];
            chatHistoryService.saveSession(recentMessages, 'recent');

            chatHistoryService.cleanupOldSessions(50, 30);

            const allSessions = chatHistoryService.getAllSessions();

            // Should have 2 sessions: old-pinned and recent
            expect(allSessions.length).toBe(2);
            expect(allSessions.some(s => s.id === 'old-pinned')).toBe(true);
            expect(allSessions.some(s => s.id === 'recent')).toBe(true);
            expect(allSessions.some(s => s.id === 'old-unpinned')).toBe(false);
        });

        it('should remove old unpinned sessions', () => {
            const oldDate = Date.now() - (31 * 24 * 60 * 60 * 1000);

            // Create old session
            const messages = [{ role: 'user' as const, content: 'Old message' }];
            chatHistoryService.saveSession(messages, 'old-session');

            // Manually set old date
            const sessions = JSON.parse(localStorage.getItem('graft_chat_history') || '[]');
            sessions[0].createdAt = oldDate;
            localStorage.setItem('graft_chat_history', JSON.stringify(sessions));

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
