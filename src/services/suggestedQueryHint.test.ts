import {
    buildSuggestedQuery,
    formatSuggestedQueryFooter,
    userAlreadyUsedConciseQuery,
} from './suggestedQueryHint';

describe('buildSuggestedQuery', () => {
    it('builds scoped panel fix template', () => {
        const q = buildSuggestedQuery({
            task: 'panel_fix_scoped',
            userMessage: 'dashboard 6gawrgawrgragg panel id#35 Status 400',
            dashboardUid: '6gawrgawrgragg',
            panelId: 35,
            panelTitle: 'Module 5 Current',
        });
        expect(q).toContain('Fix only');
        expect(q).toContain('6gawrgawrgragg');
        expect(q).toContain('panel id 35');
        expect(q).toContain('Do not change other panels');
    });

    it('builds clone template', () => {
        const q = buildSuggestedQuery({
            task: 'clone',
            userMessage: 'copy dashboard',
            sourceMachine: '2103-176030',
            targetMachine: '2505-200033',
            dashboardTitle: '2505-200033 / Keysight',
        });
        expect(q).toContain('2103-176030');
        expect(q).toContain('2505-200033');
    });
});

describe('formatSuggestedQueryFooter', () => {
    it('appends faster next time block', () => {
        const footer = formatSuggestedQueryFooter({
            task: 'panel_fix_scoped',
            userMessage: 'help',
            dashboardUid: 'abc123xyz',
            panelId: 35,
        });
        expect(footer).toContain('Faster next time');
        expect(footer).toContain('abc123xyz');
    });

    it('skips when user already wrote a concise scoped query', () => {
        const msg =
            'Fix only panel id 35 on dashboard uid 6gawrgawrgragg. Do not change other panels: Status 400';
        expect(userAlreadyUsedConciseQuery(msg, msg)).toBe(true);
        expect(
            formatSuggestedQueryFooter({
                task: 'panel_fix_scoped',
                userMessage: msg,
                dashboardUid: '6gawrgawrgragg',
                panelId: 35,
            })
        ).toBe('');
    });
});
