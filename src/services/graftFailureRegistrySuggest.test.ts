import { suggestRegistryRowForFailure } from './graftFailureRegistrySuggest';
import type { GraftFailureEntry } from './graftOperatorFailureLog';
import { userWantsDashboardRebuild } from './dashboardRebuildParse';

describe('graftFailureRegistrySuggest', () => {
    it('suggests dashboard_rebuild for rebuild prompts', () => {
        const row = suggestRegistryRowForFailure({
            id: '1',
            at: Date.now(),
            buildNumber: 144,
            intent: 'full-llm',
            userMessagePreview:
                'Rebuild the dashboard of UID = cfo0wckufbdhce from scratch using best practices.',
            error: 'Unknown error',
        });
        expect(row.kind).toBe('dashboard_rebuild');
        expect(userWantsDashboardRebuild(row.triggers)).toBe(false);
    });

    it('marks the clone handler implemented (programmatic one-pass clone)', () => {
        const row = suggestRegistryRowForFailure({
            id: '2',
            at: Date.now(),
            buildNumber: 144,
            intent: 'full-llm',
            userMessagePreview: 'Create a visual copy of 2103-176030 for machine 2505-200033',
            error: 'rate limit',
        } as GraftFailureEntry);
        expect(row.kind).toBe('dashboard_clone');
        expect(row.status).toBe('wired_fast_path');
    });
});
