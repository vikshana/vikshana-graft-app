import { applyOperatorFriendlyDashboardSaveReply } from './dashboardConciseSaveReply';
import type { ToolExecution } from '../types/llm.types';

describe('dashboardConciseSaveReply', () => {
    const panelTable =
        '**Panel index** — uid `abc123` · 2505-200033 / Keysight\n| **0** | 103 | Overview | timeseries |';

    it('replaces verbose model text with Done block at end', () => {
        const user = 'Update panel titles on dashboard 2505-200033 / Keysight to use the new machine label';
        const modelText =
            'I have updated all panels.\n\n---\n' +
            panelTable +
            '\n\n**Dashboard lookup reference**\n| 1 | Keysight |';
        const tools: ToolExecution[] = [
            {
                name: 'update_dashboard',
                status: 'success',
                summary: 'Saved dashboard uid=abc123, version=42',
            },
            { name: 'get_dashboard_summary', status: 'success', userReference: panelTable },
        ];
        const out = applyOperatorFriendlyDashboardSaveReply(modelText, tools, [user], user);
        expect(out).toContain('### Done (dashboard saved)');
        expect(out).toContain('version **42**');
        expect(out).not.toContain('Panel index');
        expect(out).not.toContain('arrayIndex');
        expect(out.lastIndexOf('Hard-refresh')).toBeGreaterThan(out.indexOf('### Done (dashboard saved)'));
    });
});
