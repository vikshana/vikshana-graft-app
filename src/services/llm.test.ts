import {
    buildContinuationUserMessage,
    needsDashboardContinueNudge,
    userWantsDashboardWork,
} from './llm';
import type { ToolExecution } from '../types/llm.types';
import { DASHBOARD_REVIEW_EXAMPLE_PROMPT } from './dashboardReviewParse';

const cloneUser =
    'Create a new dashboard named "2505-200033 / GlenTest" that is a visual copy of 2103-176030.';

function panelTable(uid: string, title: string, count: number): string {
    const rows = Array.from({ length: count }, (_, i) => `| **${i}** | ${100 + i} | Panel ${i} | timeseries |`);
    return `**Panel index** — uid \`${uid}\` · ${title}\n${rows.join('\n')}`;
}

describe('userWantsDashboardWork', () => {
    it('matches create / visual copy requests', () => {
        expect(
            userWantsDashboardWork(
                'Create a new dashboard that is a visual copy of 2103-176030, with data from machine 2505-200033.'
            )
        ).toBe(true);
    });
});

describe('needsDashboardContinueNudge', () => {
    it('detects planning text without a successful save', () => {
        const tools: ToolExecution[] = [
            { name: 'search_dashboards', status: 'success' },
            { name: 'get_dashboard_by_uid', status: 'success' },
        ];
        expect(
            needsDashboardContinueNudge(
                'update all panels on this dashboard',
                'Now I will update the panels with the new queries.',
                tools
            )
        ).toBe(true);
    });

    it('detects clarification questions after lookup only', () => {
        const tools: ToolExecution[] = [
            { name: 'search_dashboards', status: 'success' },
            { name: 'get_dashboard_summary', status: 'success' },
        ];
        expect(
            needsDashboardContinueNudge(
                'Create a new dashboard visual copy of 2103-176030 for machine 2505-200033',
                'Would you like me to update the existing dashboard or create a new one? Which would you prefer?',
                tools
            )
        ).toBe(true);
    });

    it('detects lookup-only stop for clone requests (panel tables, no save)', () => {
        const user = cloneUser;
        const tools: ToolExecution[] = [
            {
                name: 'get_dashboard_summary',
                status: 'success',
                userReference: panelTable('idHkqdqnk', '2103-176030 / Skywater-MN', 34),
            },
        ];
        expect(
            needsDashboardContinueNudge(
                user,
                `I'll now create the new dashboard by cloning the source.`,
                tools
            )
        ).toBe(true);
    });

    it('returns false after update_dashboard succeeded and clone is complete', () => {
        const tools: ToolExecution[] = [{ name: 'update_dashboard', status: 'success' }];
        expect(
            needsDashboardContinueNudge(
                'update the panels',
                "Done — all panels updated.",
                tools
            )
        ).toBe(false);
    });

    it('returns true after partial clone save when target has fewer panels', () => {
        const history = [cloneUser, 'Continue'];
        const tools: ToolExecution[] = [
            { name: 'update_dashboard', status: 'success' },
            {
                name: 'get_dashboard_summary',
                status: 'success',
                userReference: panelTable('idHkqdqnk', '2103-176030 / Skywater-MN', 34),
            },
            {
                name: 'get_dashboard_summary',
                status: 'success',
                userReference: panelTable('efnv9we9u9n9cd', '2505-200033 / GlenTest', 2),
            },
        ];
        expect(
            needsDashboardContinueNudge(
                'Continue',
                "Now I'll add all remaining panels from the source dashboard.",
                tools,
                history
            )
        ).toBe(true);
    });

    it('returns false for non-edit requests', () => {
        expect(
            needsDashboardContinueNudge('what is the error rate?', 'I will query prometheus', [])
        ).toBe(false);
    });

    it('does not nudge review-only readability prompts after lookup', () => {
        const tools: ToolExecution[] = [{ name: 'get_dashboard_by_uid', status: 'success' }];
        expect(
            needsDashboardContinueNudge(
                DASHBOARD_REVIEW_EXAMPLE_PROMPT,
                'Would you like me to apply these improvements? (Yes / prioritize which one)',
                tools,
                [DASHBOARD_REVIEW_EXAMPLE_PROMPT]
            )
        ).toBe(false);
    });

    it('nudges scoped panel fix until update_dashboard succeeds', () => {
        const user =
            'Fix only panel id 35 on dashboard uid 6gawrgawrgragg. Do not change other panels: Flux query invalid.';
        const tools: ToolExecution[] = [{ name: 'get_dashboard_by_uid', status: 'success' }];
        expect(
            needsDashboardContinueNudge(user, 'I inspected panel 35.', tools, [user])
        ).toBe(true);
        expect(
            needsDashboardContinueNudge(
                user,
                'Saved.',
                [{ name: 'get_dashboard_by_uid', status: 'success' }, { name: 'update_dashboard', status: 'success' }],
                [user]
            )
        ).toBe(false);
    });
});

describe('buildContinuationUserMessage', () => {
    it('adds clone instructions for visual copy requests', () => {
        const msg = buildContinuationUserMessage('Create a visual copy of dashboard X for machine Y');
        // Fresh clone continuations route to the directive forced-clone message,
        // which mandates the save and forbids asking the user questions.
        expect(msg).toContain('MANDATORY save');
        expect(msg).toMatch(/asking the user questions/i);
    });

    it('includes panel range when clone is incomplete', () => {
        const user =
            'Create a new dashboard named "2505-200033 / GlenTest" that is a visual copy of 2103-176030.';
        const tools: ToolExecution[] = [
            {
                name: 'get_dashboard_summary',
                status: 'success',
                userReference: panelTable('idHkqdqnk', '2103-176030 / Skywater-MN', 34),
            },
            {
                name: 'get_dashboard_summary',
                status: 'success',
                userReference: panelTable('efnv9we9u9n9cd', '2505-200033 / GlenTest', 2),
            },
        ];
        const msg = buildContinuationUserMessage(user, tools, [user]);
        expect(msg).toContain('arrayIndex 2 through 33');
        expect(msg).toContain('efnv9we9u9n9cd');
    });

    it('uses forced panel-fix continue for scoped fix requests', () => {
        const user =
            'Fix only panel id 35 on dashboard uid 6gawrgawrgragg. Do not change other panels: Flux invalid.';
        const msg = buildContinuationUserMessage(user, [], [user]);
        expect(msg).toContain('MANDATORY save');
        expect(msg).toContain('6gawrgawrgragg');
        expect(msg).toContain('panelId 35');
    });
});
