import {
    formatContinueActionBlock,
    hasSuccessfulDashboardSave,
    isSyntheticContinueUserMessage,
    responseNeedsContinueAction,
} from './continueAction';

describe('continueAction', () => {
    it('detects not finished status', () => {
        expect(
            responseNeedsContinueAction('### Not finished yet\n\n**What to do:** Reply **Continue**')
        ).toBe(true);
    });

    it('does not flag done status', () => {
        expect(responseNeedsContinueAction('### Done (Flux panel repaired)\n\nSaved.')).toBe(false);
    });

    it('detects action required heading', () => {
        expect(responseNeedsContinueAction(`### ⏸ Action required\n${formatContinueActionBlock()}`)).toBe(
            true
        );
    });

    it('flags synthetic continue user messages', () => {
        expect(isSyntheticContinueUserMessage({ role: 'user', content: 'Continue' })).toBe(true);
        expect(isSyntheticContinueUserMessage({ role: 'user', content: 'continue.' })).toBe(true);
        expect(isSyntheticContinueUserMessage({ role: 'user', content: 'Fix panel X' })).toBe(false);
    });

    it('detects successful save in tools', () => {
        expect(
            hasSuccessfulDashboardSave([
                { name: 'get_dashboard_by_uid', status: 'success' },
                { name: 'update_dashboard', status: 'success' },
            ])
        ).toBe(true);
    });
});
