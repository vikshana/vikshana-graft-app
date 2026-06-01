import {
    appendDashboardReferencesToReply,
    appendSaveVerificationWarning,
    claimsDashboardSaveWithoutTool,
} from './appendToolReferences';
import type { ToolExecution } from '../types/llm.types';

describe('appendToolReferences', () => {
    const panelTable = '**Panel index** — uid `abc`';

    it('appends panel reference when missing from reply', () => {
        const tools: ToolExecution[] = [{ name: 'get_dashboard_summary', status: 'success', userReference: panelTable }];
        const out = appendDashboardReferencesToReply('Done!', tools);
        expect(out).toContain('Panel index');
        expect(out).toContain('abc');
    });

    it('does not duplicate when reply already has table', () => {
        const tools: ToolExecution[] = [{ name: 'get_dashboard_summary', status: 'success', userReference: panelTable }];
        const out = appendDashboardReferencesToReply('See Panel index below', tools);
        expect(out).toBe('See Panel index below');
    });

    it('warns when model claims save without update_dashboard', () => {
        const tools: ToolExecution[] = [{ name: 'get_dashboard_summary', status: 'success' }];
        expect(
            claimsDashboardSaveWithoutTool("Done! I've successfully updated all 8 panel titles.", tools)
        ).toBe(true);
        const out = appendSaveVerificationWarning(
            "Done! I've successfully updated all 8 panel titles.",
            tools
        );
        expect(out).toContain('No confirmed');
    });
});
