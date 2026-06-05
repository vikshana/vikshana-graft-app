import {
    assistantAskedPendingQuestion,
    buildContinuationFromPendingTask,
    buildConfirmedIntent,
    clearPendingDashboardTask,
    getPendingDashboardTask,
    isShortFollowUpMessage,
    resolveEffectiveUserMessage,
    setPendingDashboardTask,
} from './dashboardPendingTask';

describe('dashboardPendingTask', () => {
    beforeEach(() => {
        clearPendingDashboardTask();
        sessionStorage.clear();
    });

    it('detects short confirmations', () => {
        expect(isShortFollowUpMessage('yes in order including with the ones at end')).toBe(true);
        expect(isShortFollowUpMessage('Continue')).toBe(true);
        expect(
            isShortFollowUpMessage(
                'On dashboard "2406-176021 / Exsolve", rearrange all Module N Current panels in order'
            )
        ).toBe(false);
    });

    it('detects assistant pending questions', () => {
        expect(
            assistantAskedPendingQuestion(
                'Should I also move the Module 5 RandomForest panels, or keep them at the end?'
            )
        ).toBe(true);
        expect(assistantAskedPendingQuestion('I need more context about what items to order.')).toBe(true);
    });

    it('rewrites short follow-up using session pending task', () => {
        setPendingDashboardTask({
            kind: 'module_reorder',
            intentMessage:
                'On dashboard "2406-176021 / Exsolve", rearrange Module N Current panels 1-8 in order.',
            dashboardTitle: '2406-176021 / Exsolve',
            updatedAt: Date.now(),
        });
        const result = resolveEffectiveUserMessage('yes in order including randomforest', {
            priorUserMessages: [],
            lastAssistantMessage: 'Should I also move the RandomForest panels?',
        });
        expect(result.replaced).toBe(true);
        expect(result.effective).toContain('Operator confirmation');
        expect(result.effective).toContain('update_dashboard');
    });

    it('recovers pending task from prior user when session empty', () => {
        const prior =
            'On dashboard "2406-176021 / Exsolve", rearrange Module N Current panels by number, same size.';
        const result = resolveEffectiveUserMessage('yes including all', {
            priorUserMessages: [prior],
            lastAssistantMessage: 'Should I also move the Module 5 RandomForest panels?',
        });
        expect(result.replaced).toBe(true);
        expect(getPendingDashboardTask()?.intentMessage).toContain('2406-176021');
    });

    it('buildContinuationFromPendingTask uses stored intent', () => {
        setPendingDashboardTask({
            kind: 'layout',
            intentMessage: 'Reorder panels on uid abc',
            updatedAt: Date.now(),
        });
        const msg = buildContinuationFromPendingTask();
        expect(msg).toContain('Reorder panels on uid abc');
        expect(msg).toContain('Continue');
    });

    it('buildConfirmedIntent forbids re-asking', () => {
        const text = buildConfirmedIntent(
            {
                kind: 'dashboard_edit',
                intentMessage: 'Fix panel 5',
                updatedAt: Date.now(),
            },
            'yes'
        );
        expect(text).toContain('do not ask again');
        expect(text).toContain('get_dashboard_by_uid');
    });
});
