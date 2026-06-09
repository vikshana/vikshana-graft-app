import { classifyLlmIntent } from './llmIntentRouter';
import { DASHBOARD_REVIEW_EXAMPLE_PROMPT } from './dashboardReviewParse';

describe('classifyLlmIntent', () => {
    it('classifies review prompts as read_only', () => {
        expect(classifyLlmIntent(DASHBOARD_REVIEW_EXAMPLE_PROMPT)).toBe('read_only');
    });

    it('classifies panel rename as programmatic', () => {
        expect(
            classifyLlmIntent(
                'Rename the "Pressure Gauge" panel to "System Pressure" on dashboard UID = cfo0wckufbdhce'
            )
        ).toBe('programmatic');
    });

    it('classifies panel remove as programmatic', () => {
        expect(classifyLlmIntent('remove the Cartridge Happiness Panel')).toBe('programmatic');
    });

    it('classifies mutating dashboard work', () => {
        expect(classifyLlmIntent('Create 50 panels covering every available metric on the dashboard')).toBe(
            'programmatic'
        );
    });

    it('classifies casual chat as conversational', () => {
        expect(classifyLlmIntent('hello')).toBe('conversational');
    });
});
