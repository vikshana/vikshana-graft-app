import { parseCloneIntentMessage } from './dashboardCloneParse';
import {
    resolveDashboardCloneIntent,
    userWantsDashboardClone,
    userWantsDashboardPanelFix,
} from './dashboardCloneProgress';
import { setActiveCloneIntent, clearActiveCloneIntent } from './cloneSessionStorage';

const cloneUser =
    'Create a new dashboard named "2505-200033 / GlenTest" that is a visual copy of 2103-176030.';

const fixUser =
    'Fix panels on 2505-200033 / GlenTest that show errors or still use 2103-176030 instead of 2505-200033.';

const keysightFixUser =
    'Fix panels on 2505-200033 / Keysight that show errors or still use 2103-176030 instead of 2505-200033.';

describe('userWantsDashboardPanelFix', () => {
    it('matches panel fix requests', () => {
        expect(userWantsDashboardPanelFix(fixUser)).toBe(true);
        expect(userWantsDashboardPanelFix(keysightFixUser)).toBe(true);
        expect(userWantsDashboardPanelFix(cloneUser)).toBe(false);
    });

    it('matches fix only panel scoped commands', () => {
        const scoped =
            'Fix only panel named "Module 5 Current — vs. Peer Band" on dashboard uid 6gawrgawrgragg. Do not change other panels.';
        expect(userWantsDashboardPanelFix(scoped)).toBe(true);
    });

    it('matches panel error reports without the word fix', () => {
        expect(
            userWantsDashboardPanelFix(
                'dashboard named "2505-200033 / GlenTest" has a panel named "total current" that shows these errors'
            )
        ).toBe(true);
    });
});

const totalCuMassPanelCopy =
    'Make a new panel on the 2505-200033 / NewMachine dashboard that is a copy of the "Total Cu Mass" panel on 2406-176021 / Exsolve';

describe('single-panel copy vs full clone', () => {
    it('does not treat Total Cu Mass prompt as dashboard clone', () => {
        expect(userWantsDashboardClone(totalCuMassPanelCopy)).toBe(false);
        expect(resolveDashboardCloneIntent([totalCuMassPanelCopy])).toBeUndefined();
        expect(resolveDashboardCloneIntent([totalCuMassPanelCopy, 'Continue'])).toBeUndefined();
    });

    it('clones Copy <machine> for <machine> shorthand', () => {
        expect(userWantsDashboardClone('Copy 2103-176030 for 2505-200033.')).toBe(true);
    });

    it('clones "Clone dashboard <id> and rename it to <id>" from the write-up', () => {
        const prompt = 'Clone dashboard 2103-176030 and rename it to 2505-200033';
        expect(userWantsDashboardClone(prompt)).toBe(true);
        expect(parseCloneIntentMessage(prompt).valid).toBe(true);
        expect(parseCloneIntentMessage(prompt).sourceMachineId).toBe('2103-176030');
        expect(parseCloneIntentMessage(prompt).targetMachineId).toBe('2505-200033');
    });

    it('does not treat Grafana how-to copy questions as a clone', () => {
        expect(userWantsDashboardClone('How do I copy a dashboard in Grafana?')).toBe(false);
    });

    it('does not treat "based on last review" as a dashboard clone', () => {
        expect(
            userWantsDashboardClone('Fix panels on the dashboard based on the last review.')
        ).toBe(false);
    });
});

describe('resolveDashboardCloneIntent', () => {
    beforeEach(() => {
        clearActiveCloneIntent();
    });

    it('ignores stale clone intent when user asks to fix panels', () => {
        setActiveCloneIntent(cloneUser);
        expect(resolveDashboardCloneIntent([cloneUser, fixUser])).toBeUndefined();
    });

    it('still resolves clone after Continue', () => {
        setActiveCloneIntent(cloneUser);
        expect(resolveDashboardCloneIntent([cloneUser, 'Continue'])).toBe(cloneUser);
    });
});
