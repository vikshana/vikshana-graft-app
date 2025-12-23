// Import types from centralized location
import type { UserPrompt, CategoryDef, PreConfiguredPrompts } from '../types/prompt.types';
import { PRE_CONFIGURED_PROMPTS } from '../data/prompts';

// Re-export for backward compatibility
export type { UserPrompt };

const STORAGE_KEY = 'graft_user_prompts';
const PIN_LIMIT = 20;

let configuredPrompts: CategoryDef[] = [];

export const promptLibraryService = {
    setConfiguredPrompts: (prompts: CategoryDef[]) => {
        configuredPrompts = prompts;
    },

    getPreConfiguredPrompts: (): PreConfiguredPrompts => {
        if (configuredPrompts && configuredPrompts.length > 0) {
            const converted: PreConfiguredPrompts = {};
            configuredPrompts.forEach(cat => {
                converted[cat.name] = {};
                cat.subCategories.forEach(sub => {
                    converted[cat.name][sub.name] = sub.prompts.map(p => p.content);
                });
            });
            return converted;
        }
        return PRE_CONFIGURED_PROMPTS;
    },

    getUserPrompts: (): UserPrompt[] => {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            return stored ? JSON.parse(stored) : [];
        } catch (e) {
            console.error('Failed to load user prompts', e);
            return [];
        }
    },

    saveUserPrompt: (prompt: Omit<UserPrompt, 'id' | 'createdAt'> & { id?: string }): UserPrompt => {
        const prompts = promptLibraryService.getUserPrompts();
        const now = Date.now();

        let savedPrompt: UserPrompt;

        if (prompt.id) {
            // Update existing
            const index = prompts.findIndex(p => p.id === prompt.id);
            if (index >= 0) {
                savedPrompt = { ...prompts[index], ...prompt, id: prompt.id };
                prompts[index] = savedPrompt;
            } else {
                // Should not happen, but fallback to create
                savedPrompt = { ...prompt, id: Date.now().toString() + Math.random().toString(36).substring(2, 9), createdAt: now, isPinned: false } as UserPrompt;
                prompts.push(savedPrompt);
            }
        } else {
            // Create new
            savedPrompt = { ...prompt, id: Date.now().toString() + Math.random().toString(36).substring(2, 9), createdAt: now, isPinned: false } as UserPrompt;
            prompts.push(savedPrompt);
        }

        localStorage.setItem(STORAGE_KEY, JSON.stringify(prompts));
        return savedPrompt;
    },

    deleteUserPrompt: (id: string) => {
        const prompts = promptLibraryService.getUserPrompts();
        const filtered = prompts.filter(p => p.id !== id);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
    },

    togglePin: (id: string): boolean => {
        const prompts = promptLibraryService.getUserPrompts();
        const prompt = prompts.find(p => p.id === id);

        if (!prompt) {
            return false;
        }

        if (!prompt.isPinned) {
            // Check limit
            const pinnedCount = prompts.filter(p => p.isPinned).length;
            if (pinnedCount >= PIN_LIMIT) {
                throw new Error(`Pin limit reached (max ${PIN_LIMIT})`);
            }
            prompt.isPinned = true;
        } else {
            prompt.isPinned = false;
        }

        localStorage.setItem(STORAGE_KEY, JSON.stringify(prompts));
        return true;
    },

    getPinnedPrompts: (): UserPrompt[] => {
        return promptLibraryService.getUserPrompts().filter(p => p.isPinned);
    },

    getCategories: (): string[] => {
        const prompts = promptLibraryService.getUserPrompts();
        const categories = new Set<string>();
        prompts.forEach(p => {
            if (p.category) {
                categories.add(p.category);
            }
        });
        return Array.from(categories).sort();
    },

    getUserPromptsSorted: (): UserPrompt[] => {
        const prompts = promptLibraryService.getUserPrompts();
        // Sort by pinned status first (pinned = true comes first), then by creation date (newest first)
        return prompts.sort((a, b) => {
            if (a.isPinned === b.isPinned) {
                return b.createdAt - a.createdAt;
            }
            return a.isPinned ? -1 : 1;
        });
    },

    // Pre-configured prompts pinning
    getPinnedPreConfiguredPrompts: (): string[] => {
        try {
            const stored = localStorage.getItem('graft_pinned_preconfigured');
            return stored ? JSON.parse(stored) : [];
        } catch (e) {
            console.error('Failed to load pinned preconfigured prompts', e);
            return [];
        }
    },

    togglePreConfiguredPin: (content: string): boolean => {
        const pinned = promptLibraryService.getPinnedPreConfiguredPrompts();
        const index = pinned.indexOf(content);
        let newPinned: string[];

        if (index >= 0) {
            // Unpin
            newPinned = pinned.filter(p => p !== content);
        } else {
            // Pin
            if (pinned.length >= PIN_LIMIT) {
                throw new Error(`Pin limit reached (max ${PIN_LIMIT})`);
            }
            newPinned = [...pinned, content];
        }

        localStorage.setItem('graft_pinned_preconfigured', JSON.stringify(newPinned));
        return index === -1; // Returns true if it was pinned, false if unpinned
    },

    isPreConfiguredPromptPinned: (content: string): boolean => {
        const pinned = promptLibraryService.getPinnedPreConfiguredPrompts();
        return pinned.includes(content);
    }
};
