import yaml from 'js-yaml';
import { CategoryDef } from '../types/prompt.types';

export const validatePromptYaml = (content: string): CategoryDef[] => {
    let parsed: any;
    try {
        parsed = yaml.load(content);
    } catch (e) {
        throw new Error('Invalid YAML format');
    }

    if (!Array.isArray(parsed)) {
        throw new Error('Root must be an array of categories');
    }

    const categoryIds = new Set<string>();

    parsed.forEach((category: any, index: number) => {
        if (!category.id || typeof category.id !== 'string') {
            throw new Error(`Category at index ${index} missing or invalid 'id'`);
        }
        if (categoryIds.has(category.id)) {
            throw new Error(`Duplicate category id: ${category.id}`);
        }
        categoryIds.add(category.id);

        if (!category.name || typeof category.name !== 'string') {
            throw new Error(`Category '${category.id}' missing or invalid 'name'`);
        }

        if (!category.subCategories || !Array.isArray(category.subCategories)) {
            throw new Error(`Category '${category.id}' missing or invalid 'subCategories'`);
        }

        const subCategoryIds = new Set<string>();

        category.subCategories.forEach((subCategory: any, subIndex: number) => {
            if (!subCategory.id || typeof subCategory.id !== 'string') {
                throw new Error(`SubCategory at index ${subIndex} in category '${category.id}' missing or invalid 'id'`);
            }
            if (subCategoryIds.has(subCategory.id)) {
                throw new Error(`Duplicate subCategory id '${subCategory.id}' in category '${category.id}'`);
            }
            subCategoryIds.add(subCategory.id);

            if (!subCategory.name || typeof subCategory.name !== 'string') {
                throw new Error(`SubCategory '${subCategory.id}' in category '${category.id}' missing or invalid 'name'`);
            }

            if (!subCategory.prompts || !Array.isArray(subCategory.prompts)) {
                throw new Error(`SubCategory '${subCategory.id}' in category '${category.id}' missing or invalid 'prompts'`);
            }

            subCategory.prompts.forEach((prompt: any, promptIndex: number) => {
                if (!prompt.name || typeof prompt.name !== 'string') {
                    throw new Error(`Prompt at index ${promptIndex} in subCategory '${subCategory.id}' missing or invalid 'name'`);
                }
                if (!prompt.content || typeof prompt.content !== 'string') {
                    throw new Error(`Prompt '${prompt.name}' in subCategory '${subCategory.id}' missing or invalid 'content'`);
                }
            });
        });
    });

    return parsed as CategoryDef[];
};

export const dumpPromptYaml = (categories: CategoryDef[]): string => {
    // First, convert to YAML
    const yamlString = yaml.dump(categories, {
        indent: 2,
        lineWidth: 120,
        noRefs: true,
        sortKeys: false,
        quotingType: '"',
        forceQuotes: false,
    });

    // Validate that the generated YAML can be parsed back correctly
    try {
        const reparsed = validatePromptYaml(yamlString);

        // Ensure the round-trip preserves the data structure
        if (reparsed.length !== categories.length) {
            throw new Error('YAML round-trip validation failed: category count mismatch');
        }
    } catch (error) {
        console.error('Generated YAML failed validation:', error);
        throw new Error(`Failed to generate valid YAML: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    return yamlString;
};
