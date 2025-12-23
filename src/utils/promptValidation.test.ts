import { validatePromptYaml, dumpPromptYaml } from './promptValidation';
import type { CategoryDef } from '../types/prompt.types';

describe('validatePromptYaml', () => {
  it('should validate a correct YAML', () => {
    const yaml = `
- id: "coding"
  name: "Coding"
  subCategories:
    - id: "python"
      name: "Python"
      prompts:
        - name: "Explain Code"
          content: "Explain this code"
`;
    const result = validatePromptYaml(yaml);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('coding');
    expect(result[0].subCategories[0].id).toBe('python');
  });

  it('should throw error for invalid YAML syntax', () => {
    const yaml = `
- id: "coding"
  name: "Coding"
  subCategories:
    - id: "python"
      name: "Python"
      prompts:
        - name: "Explain Code"
          content: "Explain this code"
  invalid_indentation
`;
    expect(() => validatePromptYaml(yaml)).toThrow('Invalid YAML format');
  });

  it('should throw error if root is not an array', () => {
    const yaml = `
id: "coding"
name: "Coding"
`;
    expect(() => validatePromptYaml(yaml)).toThrow('Root must be an array of categories');
  });

  it('should throw error for missing category id', () => {
    const yaml = `
- name: "Coding"
  subCategories: []
`;
    expect(() => validatePromptYaml(yaml)).toThrow("Category at index 0 missing or invalid 'id'");
  });

  it('should throw error for duplicate category id', () => {
    const yaml = `
- id: "coding"
  name: "Coding"
  subCategories: []
- id: "coding"
  name: "Coding 2"
  subCategories: []
`;
    expect(() => validatePromptYaml(yaml)).toThrow("Duplicate category id: coding");
  });

  it('should throw error for missing subCategories', () => {
    const yaml = `
- id: "coding"
  name: "Coding"
`;
    expect(() => validatePromptYaml(yaml)).toThrow("Category 'coding' missing or invalid 'subCategories'");
  });

  it('should throw error for duplicate subCategory id within same category', () => {
    const yaml = `
- id: "coding"
  name: "Coding"
  subCategories:
    - id: "python"
      name: "Python"
      prompts: []
    - id: "python"
      name: "Python 2"
      prompts: []
`;
    expect(() => validatePromptYaml(yaml)).toThrow("Duplicate subCategory id 'python' in category 'coding'");
  });

  it('should throw error for missing prompts in subCategory', () => {
    const yaml = `
- id: "coding"
  name: "Coding"
  subCategories:
    - id: "python"
      name: "Python"
`;
    expect(() => validatePromptYaml(yaml)).toThrow("SubCategory 'python' in category 'coding' missing or invalid 'prompts'");
  });

  it('should throw error for invalid prompt structure', () => {
    const yaml = `
- id: "coding"
  name: "Coding"
  subCategories:
    - id: "python"
      name: "Python"
      prompts:
        - name: "Explain Code"
`;
    expect(() => validatePromptYaml(yaml)).toThrow("Prompt 'Explain Code' in subCategory 'python' missing or invalid 'content'");
  });
});

describe('dumpPromptYaml', () => {
  test('generates valid YAML that can be re-parsed', () => {
    const categories: CategoryDef[] = [
      {
        id: 'coding',
        name: 'Coding',
        subCategories: [
          {
            id: 'python',
            name: 'Python',
            prompts: [
              {
                name: 'Explain Code',
                content: 'Explain this code:\n\n```python\n${selection}\n```'
              }
            ]
          }
        ]
      }
    ];

    const yaml = dumpPromptYaml(categories);

    expect(yaml).toContain('id: coding');
    expect(yaml).toContain('name: Coding');
    expect(yaml).toContain('subCategories:');
    expect(yaml).toContain('id: python');
    expect(yaml).toContain('prompts:');
  });

  test('validates exported YAML can be imported back', () => {
    const categories: CategoryDef[] = [
      {
        id: 'test',
        name: 'Test Category',
        subCategories: [
          {
            id: 'sub1',
            name: 'Sub Category 1',
            prompts: [
              { name: 'Prompt 1', content: 'Content 1' },
              { name: 'Prompt 2', content: 'Content 2' }
            ]
          }
        ]
      }
    ];

    const yaml = dumpPromptYaml(categories);
    const reparsed = validatePromptYaml(yaml);

    expect(reparsed).toHaveLength(1);
    expect(reparsed[0].id).toBe('test');
    expect(reparsed[0].subCategories).toHaveLength(1);
    expect(reparsed[0].subCategories[0].prompts).toHaveLength(2);
  });

  test('throws error if validation fails during export', () => {
    const badCategories = [
      {
        id: 'test',
        name: 'Test',
        subCategories: [
          {
            id: 'sub1',
            name: 'Sub 1'
            // Missing prompts array - should fail validation
          }
        ]
      }
    ] as any;

    expect(() => dumpPromptYaml(badCategories)).toThrow(/missing or invalid 'prompts'/);
  });
});
