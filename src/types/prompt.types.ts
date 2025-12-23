// Prompt library related type definitions

/**
 * User-created prompt with metadata
 */
export interface UserPrompt {
    id: string;
    title: string;
    content: string;
    category?: string;
    isPinned?: boolean;
    createdAt: number;
}

/**
 * Pre-configured prompts organized by category and subcategory
 */
export type PreConfiguredPrompts = Record<string, Record<string, string[]>>;

export interface PromptDef {
    name: string;
    content: string;
}

export interface SubCategoryDef {
    id: string;
    name: string;
    prompts: PromptDef[];
}

export interface CategoryDef {
    id: string;
    name: string;
    subCategories: SubCategoryDef[];
}
