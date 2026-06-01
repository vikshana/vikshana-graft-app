import { needsDashboardContinueNudge } from './llm';
import type { ToolExecution } from '../types/llm.types';

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

    it('returns false after update_dashboard succeeded', () => {
        const tools: ToolExecution[] = [{ name: 'update_dashboard', status: 'success' }];
        expect(
            needsDashboardContinueNudge(
                'update the panels',
                "Now I'll update the panels",
                tools
            )
        ).toBe(false);
    });

    it('returns false for non-edit requests', () => {
        expect(
            needsDashboardContinueNudge('what is the error rate?', 'I will query prometheus', [])
        ).toBe(false);
    });
});
