import {
    SUGGESTED_PROMPTS,
    filterSuggestedPrompts,
    getSuggestedPromptCategories,
    groupSuggestedPrompts,
} from './suggestedPrompts';

describe('suggestedPrompts', () => {
    it('includes programmatic rename and clone examples', () => {
        const ids = SUGGESTED_PROMPTS.map((p) => p.id);
        expect(ids).toContain('rename-machine-dashboard');
        expect(ids).toContain('clone-machine-dashboard');
        expect(ids).toContain('single-panel-copy');
        expect(ids).toContain('bulk-peer-band-fix');
    });

    it('filters by search query', () => {
        const hits = filterSuggestedPrompts('peer band');
        expect(hits.length).toBeGreaterThan(0);
        expect(hits.every((p) => /peer band/i.test(`${p.title} ${p.description} ${p.content}`))).toBe(true);
    });

    it('groups prompts by category', () => {
        const grouped = groupSuggestedPrompts(SUGGESTED_PROMPTS);
        expect(Object.keys(grouped).length).toBe(getSuggestedPromptCategories().length);
        expect(grouped['Machine dashboards']?.length).toBeGreaterThan(0);
    });
});
