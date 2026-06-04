import { formatClarificationIfNeeded, hasDashboardIdentityForPanelFix } from './requestClarity';
import { userWantsDashboardPanelFix } from './dashboardCloneProgress';

const scopedFix =
    'on dashboard "6gawrgawrgragg" panel id#35 named "Module 5 Current" — still get Status: 400 parse error unexpected identifier "v"';

describe('hasDashboardIdentityForPanelFix', () => {
    it('accepts dashboard uid and panel id', () => {
        expect(hasDashboardIdentityForPanelFix(scopedFix)).toBe(true);
    });
});

describe('formatClarificationIfNeeded', () => {
    it('does not ask clarification when uid and panel id are present', () => {
        expect(userWantsDashboardPanelFix(scopedFix)).toBe(true);
        expect(formatClarificationIfNeeded(scopedFix)).toBeNull();
    });

    it('suggests plain-English bulk prompt when vs. Peer Band fix is vague', () => {
        const vague = 'Fix the other vs. Peer Band panels the same as Module 5';
        const clarification = formatClarificationIfNeeded(vague);
        expect(clarification).toContain('fix all panels whose title contains');
        expect(clarification).toContain('vs. Peer Band');
    });
});
