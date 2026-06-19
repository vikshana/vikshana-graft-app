import {
    applyOperatorFriendlyDashboardReply,
    assessCloneTask,
    formatPlainEnglishCloneStatus,
    panelCountsMatchClone,
    stripPanelIndexTables,
} from './dashboardTaskStatus';
import type { ToolExecution } from '../types/llm.types';

function panelTable(uid: string, title: string, count: number): string {
    const rows = Array.from({ length: count }, (_, i) => `| **${i}** | ${100 + i} | Panel ${i} | timeseries |`);
    return `**Panel index** — uid \`${uid}\` · ${title}\n${rows.join('\n')}\n**Cite in requests:** uid=${uid}`;
}

const cloneUser =
    'Create a new dashboard named "2505-200033 / GlenTest" that is a visual copy of 2103-176030, with source field data from machine 2505-200033.';

describe('assessCloneTask', () => {
    it('reports not_started when only source template was looked up', () => {
        const tools: ToolExecution[] = [
            {
                name: 'get_dashboard_summary',
                status: 'success',
                userReference: panelTable('idHkqdqnk', '2103-176030 / Skywater-MN', 34),
            },
        ];
        const status = assessCloneTask(cloneUser, tools);
        expect(status?.state).toBe('not_started');
        expect(status?.requestedTitle).toBe('2505-200033 / GlenTest');
        expect(status?.sourcePanels).toBe(34);
    });

    it('reports in_progress when target has fewer panels', () => {
        const tools: ToolExecution[] = [
            { name: 'update_dashboard', status: 'success', summary: 'Saved dashboard uid=efnv9we9u9n9cd, version=2' },
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
        expect(assessCloneTask(cloneUser, tools)?.state).toBe('in_progress');
    });

    it('reports complete when panel counts match', () => {
        const tools: ToolExecution[] = [
            // Completion of a distinct source→target clone requires save evidence.
            { name: 'update_dashboard', status: 'success', summary: 'Saved dashboard uid=efnv9we9u9n9cd, version=2' },
            {
                name: 'get_dashboard_summary',
                status: 'success',
                userReference: panelTable('idHkqdqnk', '2103-176030 / Skywater-MN', 34),
            },
            {
                name: 'get_dashboard_summary',
                status: 'success',
                userReference: panelTable('efnv9we9u9n9cd', '2505-200033 / GlenTest', 34),
            },
        ];
        expect(assessCloneTask(cloneUser, tools)?.state).toBe('complete');
    });

    it('reports complete when only target dashboard has full panel count (same uid)', () => {
        const tools: ToolExecution[] = [
            { name: 'update_dashboard', status: 'success', summary: 'Saved dashboard uid=abc, version=5' },
            {
                name: 'get_dashboard_summary',
                status: 'success',
                userReference: panelTable('abc', '2505-200033 / GlenTest', 34),
            },
        ];
        const status = assessCloneTask(cloneUser, tools);
        expect(status?.state).toBe('complete');
        expect(status?.targetPanels).toBe(34);
    });
});

describe('applyOperatorFriendlyDashboardReply panel fix', () => {
    const fixUser =
        'Fix panels on 2505-200033 / GlenTest that show errors or still use 2103-176030 instead of 2505-200033.';

    it('panel fix sessions use appendToolReferences path not clone status', async () => {
        const { appendDashboardReferencesToReply } = await import('./appendToolReferences');
        const modelText = 'Fixed panel **pH** and saved.';
        const out = appendDashboardReferencesToReply(
            modelText,
            [{ name: 'update_dashboard', status: 'success' }],
            [cloneUser, fixUser],
            fixUser
        );
        expect(out).toContain('### Done (panel fix)');
        expect(out).not.toContain('### Not finished yet');
    });
});

describe('formatPlainEnglishCloneStatus', () => {
    it('tells user to reply Continue when not started', () => {
        const text = formatPlainEnglishCloneStatus({
            state: 'not_started',
            requestedTitle: '2505-200033 / GlenTest',
            requestedMachine: '2505-200033',
            sourceTitle: '2103-176030 / Skywater-MN',
            sourcePanels: 34,
        });
        expect(text).toContain('Not finished yet');
        expect(text).toContain('Continue');
        expect(text).not.toContain('arrayIndex');
    });

    it('complete message explains panels may still error', () => {
        const text = formatPlainEnglishCloneStatus(
            {
                state: 'complete',
                requestedTitle: '2505-200033 / GlenTest',
                requestedMachine: '2505-200033',
                sourcePanels: 34,
                targetPanels: 35,
            },
            'visual copy of 2103-176030, machine 2505-200033'
        );
        expect(text).toContain('Done (layout copied)');
        expect(text).toContain('does **not** guarantee');
        expect(text).toContain('Error');
    });
});

describe('panelCountsMatchClone', () => {
    it('allows ±2 panel difference', () => {
        expect(panelCountsMatchClone(34, 35)).toBe(true);
        expect(panelCountsMatchClone(34, 30)).toBe(false);
    });
});

describe('assessCloneTask complete rules', () => {
    it('does not mark complete on save alone without target panel summary', () => {
        const intent =
            'Create a new dashboard named "2505-200033 / GlenTest" that is a visual copy of 2103-176030.';
        const tools = [{ name: 'update_dashboard', status: 'success' as const, summary: 'Saved dashboard uid=abc, version=3' }];
        expect(assessCloneTask(intent, tools)?.state).toBe('in_progress');
    });

    it('reports stuck after multiple continues without save', () => {
        const intent =
            'Create a new dashboard named "2505-200033 / GlenTest" that is a visual copy of 2103-176030.';
        const tools: ToolExecution[] = [
            {
                name: 'get_dashboard_summary',
                status: 'success',
                userReference: panelTable('idHkqdqnk', '2103-176030 / Skywater-MN', 34),
            },
        ];
        const history = [intent, 'Continue', 'Continue'];
        expect(assessCloneTask(intent, tools, history)?.state).toBe('stuck');
    });

    it('reports in_progress from session meta when Continue has no tool output', () => {
        sessionStorage.setItem('graft_active_clone_intent', cloneUser);
        sessionStorage.setItem(
            'graft_clone_session_meta',
            JSON.stringify({
                intent: cloneUser,
                continueAttempts: 1,
                cloneSourcePanelSlots: 34,
                cloneTargetPanelSlotsSaved: 6,
                requestedTitle: '2505-200033 / GlenTest',
                requestedMachine: '2505-200033',
                sourceTitle: '2103-176030 / Skywater-MN',
            })
        );
        const status = assessCloneTask(cloneUser, [], [cloneUser, 'Continue']);
        expect(status?.state).toBe('in_progress');
        expect(status?.targetPanels).toBe(6);
        expect(status?.sourcePanels).toBe(34);
        sessionStorage.removeItem('graft_clone_session_meta');
        sessionStorage.removeItem('graft_active_clone_intent');
    });

    it('reports stuck after repeated not_started streak without continue count', () => {
        const intent =
            'Create a new dashboard named "2505-200033 / GlenTest" that is a visual copy of 2103-176030.';
        const tools: ToolExecution[] = [
            {
                name: 'get_dashboard_summary',
                status: 'success',
                userReference: panelTable('idHkqdqnk', '2103-176030 / Skywater-MN', 34),
            },
        ];
        sessionStorage.setItem(
            'graft_clone_session_meta',
            JSON.stringify({ intent, continueAttempts: 0, notStartedStreak: 2 })
        );
        expect(assessCloneTask(intent, tools, [])?.state).toBe('stuck');
        sessionStorage.removeItem('graft_clone_session_meta');
    });
});

describe('applyOperatorFriendlyDashboardReply', () => {
    it('replaces planning text and panel tables with plain English status', () => {
        const modelText =
            `I'll now create the new dashboard "2505-200033 / GlenTest" by cloning the source dashboard.\n\n---\n` +
            panelTable('idHkqdqnk', '2103-176030 / Skywater-MN', 34);
        const tools: ToolExecution[] = [
            {
                name: 'get_dashboard_summary',
                status: 'success',
                userReference: panelTable('idHkqdqnk', '2103-176030 / Skywater-MN', 34),
            },
        ];
        const out = applyOperatorFriendlyDashboardReply(modelText, tools, [cloneUser]);
        expect(out).toContain('### Not finished yet');
        expect(out).toContain('Continue');
        expect(out).not.toContain('Panel index');
        expect(out).not.toContain('arrayIndex');
    });
});

describe('stripPanelIndexTables', () => {
    it('removes panel index blocks', () => {
        const text = `Hello\n\n---\n${panelTable('x', 'Title', 2)}`;
        expect(stripPanelIndexTables(text)).toBe('Hello');
    });
});
