import { config } from '@grafana/runtime';
import { getStorageSuffix, hasScopedUser, scopedStorageKey } from './storageScope';
import { promptLibraryService } from './promptLibrary';

type MutableUser = { orgId?: number | null; login?: string | null };

function setUser(user: MutableUser | null): void {
    // config.bootData is a singleton; mutate it to simulate the logged-in user.
    (config as unknown as { bootData: { user: MutableUser } }).bootData = {
        user: (user ?? {}) as MutableUser,
    };
}

describe('storageScope', () => {
    afterEach(() => {
        setUser(null);
    });

    it('returns "default" and the bare key when no user is in context', () => {
        setUser(null);
        expect(getStorageSuffix()).toBe('default');
        expect(hasScopedUser()).toBe(false);
        expect(scopedStorageKey('graft_chat_history')).toBe('graft_chat_history');
    });

    it('scopes keys by orgId + login when a user is present', () => {
        setUser({ orgId: 7, login: 'alice' });
        expect(getStorageSuffix()).toBe('7_alice');
        expect(hasScopedUser()).toBe(true);
        expect(scopedStorageKey('graft_chat_history')).toBe('graft_chat_history_7_alice');
    });

    it('produces DIFFERENT keys for different users and different orgs', () => {
        setUser({ orgId: 7, login: 'alice' });
        const aliceOrg7 = scopedStorageKey('graft_user_prompts');

        setUser({ orgId: 7, login: 'bob' });
        const bobOrg7 = scopedStorageKey('graft_user_prompts');

        setUser({ orgId: 9, login: 'alice' });
        const aliceOrg9 = scopedStorageKey('graft_user_prompts');

        expect(new Set([aliceOrg7, bobOrg7, aliceOrg9]).size).toBe(3);
    });

    it('falls back to "default" when login is missing (avoids a half-scoped key)', () => {
        setUser({ orgId: 7, login: null });
        expect(getStorageSuffix()).toBe('default');
    });

    it('isolates user-authored prompts between two users on the same browser', () => {
        localStorage.clear();

        setUser({ orgId: 1, login: 'keysight-viewer' });
        promptLibraryService.saveUserPrompt({ title: 'Mine', content: 'Keysight secret prompt' });
        expect(promptLibraryService.getUserPrompts().map((p) => p.content)).toEqual([
            'Keysight secret prompt',
        ]);

        // A different user in a different org must not see the first user's prompts.
        setUser({ orgId: 2, login: 'skywater-viewer' });
        expect(promptLibraryService.getUserPrompts()).toEqual([]);

        // Original user still has theirs.
        setUser({ orgId: 1, login: 'keysight-viewer' });
        expect(promptLibraryService.getUserPrompts().map((p) => p.content)).toEqual([
            'Keysight secret prompt',
        ]);
    });
});
