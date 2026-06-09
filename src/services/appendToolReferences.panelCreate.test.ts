import { appendDashboardReferencesToReply } from './appendToolReferences';
import type { ToolExecution } from '../types/llm.types';

describe('appendDashboardReferencesToReply panel create', () => {
    const user =
        'Create a bar chart panel called "Cartridge Comparison" for Keysight.';
    const tools: ToolExecution[] = [
        { name: 'get_dashboard_by_uid', status: 'success' },
        {
            name: 'update_dashboard',
            status: 'success',
            summary: 'Saved dashboard uid=cfo0wckufbdhce, version=90',
        },
    ];

    it('uses panel added reply instead of panel fix when LLM path saves', () => {
        const out = appendDashboardReferencesToReply(
            '**Cartridge Comparison** bar chart panel created.\n\n**Panel index** — uid `cfo0wckufbdhce`',
            tools,
            [user],
            user
        );
        expect(out).toContain('### Done (panel added)');
        expect(out).not.toContain('### Done (panel fix)');
    });
});
