import {
    appendLearnedPromptHints,
    clearLearnedPromptsForTests,
    getLearnedPromptsForKind,
    recordClarificationShown,
    tryLearnFromProgrammaticSuccess,
} from './graftPromptLearning';
import { promptLibraryService } from './promptLibrary';

describe('graftPromptLearning', () => {
    beforeEach(() => {
        clearLearnedPromptsForTests();
        localStorage.removeItem('graft_user_prompts');
    });

    it('learns a successful follow-up after ambiguous graph clarification', () => {
        const vague =
            'Create graphs that would be useful for the Keysight machine on the dashboard with UID = cfo0wckufbdhce.';
        const specific =
            'Create a gauge panel, time series panel, table panel, and stat panel for dashboard with UID = cfo0wckufbdhce.';

        recordClarificationShown('ambiguous-graph-create', vague, 'cfo0wckufbdhce');
        const learned = tryLearnFromProgrammaticSuccess({
            userMessage: specific,
            intent: 'panel-create-multi',
            dashboardUid: 'cfo0wckufbdhce',
        });

        expect(learned?.prompt).toBe(specific);
        expect(learned?.successCount).toBe(1);
        expect(getLearnedPromptsForKind('ambiguous-graph-create', 'cfo0wckufbdhce')).toHaveLength(1);

        const saved = promptLibraryService.getUserPrompts();
        expect(saved).toHaveLength(1);
        expect(saved[0].category).toBe('Learned');
        expect(saved[0].content).toBe(specific);
    });

    it('bumps success count for repeat use', () => {
        recordClarificationShown('ambiguous-graph-create', 'Create useful graphs for Keysight.');
        const prompt = 'Create 50 panels covering every available metric on the dashboard with UID = cfo0wckufbdhce';
        tryLearnFromProgrammaticSuccess({ userMessage: prompt, intent: 'dashboard-metric-panels' });
        recordClarificationShown('ambiguous-graph-create', 'Create useful graphs again.');
        const again = tryLearnFromProgrammaticSuccess({ userMessage: prompt, intent: 'dashboard-metric-panels' });
        expect(again?.successCount).toBe(2);
    });

    it('appends learned hints to clarification text', () => {
        recordClarificationShown('ambiguous-graph-create', 'Create useful graphs.');
        tryLearnFromProgrammaticSuccess({
            userMessage: 'Create a gauge panel for Keysight.',
            intent: 'panel-create',
        });
        recordClarificationShown('ambiguous-graph-create', 'Create useful graphs again.');

        const out = appendLearnedPromptHints('### Need clarification\n\nPick one.', 'ambiguous-graph-create');
        expect(out).toContain('Worked for you before');
        expect(out).toContain('Create a gauge panel for Keysight.');
    });
});
