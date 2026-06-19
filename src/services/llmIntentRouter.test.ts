import { classifyLlmIntent } from './llmIntentRouter';
import { DASHBOARD_REVIEW_EXAMPLE_PROMPT } from './dashboardReviewParse';

describe('classifyLlmIntent', () => {
    it('routes review prompts to the programmatic review handler', () => {
        // Dashboard-review requests have a dedicated programmatic handler
        // (programmaticDashboardReview), so they classify as 'programmatic'.
        expect(classifyLlmIntent(DASHBOARD_REVIEW_EXAMPLE_PROMPT)).toBe('programmatic');
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
        // No dashboard target (uid/context) means no programmatic handler applies,
        // so this falls through to the LLM 'mutating' path.
        expect(classifyLlmIntent('Create 50 panels covering every available metric on the dashboard')).toBe(
            'mutating'
        );
    });

    it('classifies casual chat as conversational', () => {
        expect(classifyLlmIntent('hello')).toBe('conversational');
    });
});
