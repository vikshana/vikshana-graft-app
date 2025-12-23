import { promptLibraryService } from './promptLibrary';
import { PRE_CONFIGURED_PROMPTS } from '../data/prompts';

describe('promptLibraryService', () => {
    beforeEach(() => {
        localStorage.clear();
        jest.clearAllMocks();
    });

    it('should return pre-configured prompts', () => {
        expect(promptLibraryService.getPreConfiguredPrompts()).toEqual(PRE_CONFIGURED_PROMPTS);
    });

    it('should save and retrieve user prompts', () => {
        const prompt = {
            title: 'Test Prompt',
            content: 'Test Content',
        };

        const saved = promptLibraryService.saveUserPrompt(prompt);
        expect(saved.id).toBeDefined();
        expect(saved.createdAt).toBeDefined();
        expect(saved.title).toBe(prompt.title);

        const retrieved = promptLibraryService.getUserPrompts();
        expect(retrieved).toHaveLength(1);
        expect(retrieved[0]).toEqual(saved);
    });

    it('should update existing user prompt', () => {
        const prompt = promptLibraryService.saveUserPrompt({
            title: 'Original',
            content: 'Content',
        });

        const updated = promptLibraryService.saveUserPrompt({
            id: prompt.id,
            title: 'Updated',
            content: 'Content',
        });

        expect(updated.title).toBe('Updated');
        const retrieved = promptLibraryService.getUserPrompts();
        expect(retrieved).toHaveLength(1);
        expect(retrieved[0].title).toBe('Updated');
    });

    it('should delete user prompt', () => {
        const prompt = promptLibraryService.saveUserPrompt({
            title: 'To Delete',
            content: 'Content',
        });

        promptLibraryService.deleteUserPrompt(prompt.id);
        expect(promptLibraryService.getUserPrompts()).toHaveLength(0);
    });

    it('should toggle pin status', () => {
        const prompt = promptLibraryService.saveUserPrompt({
            title: 'Pin Me',
            content: 'Content',
        });

        promptLibraryService.togglePin(prompt.id);
        expect(promptLibraryService.getUserPrompts()[0].isPinned).toBe(true);

        promptLibraryService.togglePin(prompt.id);
        expect(promptLibraryService.getUserPrompts()[0].isPinned).toBe(false);
    });

    it('should enforce pin limit', () => {
        // Create 20 pinned prompts
        for (let i = 0; i < 20; i++) {
            const p = promptLibraryService.saveUserPrompt({
                title: `Prompt ${i}`,
                content: 'Content',
            });
            promptLibraryService.togglePin(p.id);
        }

        const extra = promptLibraryService.saveUserPrompt({
            title: 'Extra',
            content: 'Content',
        });

        expect(() => promptLibraryService.togglePin(extra.id)).toThrow(/Pin limit reached/);
    });

    it('should toggle preconfigured pin status', () => {
        const prompt = 'Test Preconfigured Prompt';

        // Pin
        expect(promptLibraryService.togglePreConfiguredPin(prompt)).toBe(true);
        expect(promptLibraryService.getPinnedPreConfiguredPrompts()).toContain(prompt);
        expect(promptLibraryService.isPreConfiguredPromptPinned(prompt)).toBe(true);

        // Unpin
        expect(promptLibraryService.togglePreConfiguredPin(prompt)).toBe(false);
        expect(promptLibraryService.getPinnedPreConfiguredPrompts()).not.toContain(prompt);
        expect(promptLibraryService.isPreConfiguredPromptPinned(prompt)).toBe(false);
    });

    it('should enforce preconfigured pin limit', () => {
        for (let i = 0; i < 20; i++) {
            promptLibraryService.togglePreConfiguredPin(`Prompt ${i}`);
        }

        expect(() => promptLibraryService.togglePreConfiguredPin('Extra')).toThrow(/Pin limit reached/);
    });
});
