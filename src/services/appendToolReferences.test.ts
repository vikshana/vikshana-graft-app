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

    it('uses concise panel fix reply instead of appending panel index tables', () => {
        const fixUser =
            'Fix panels on 2505-200033 / Keysight that show errors or still use 2103-176030 instead of 2505-200033.';
        const panelTable =
            '**Dashboard lookup reference**\n| 1 | 2505-200033 / Keysight |\n\n**Panel index** — uid `bfnxe8326lvcwb`';
        const modelText =
            '**Done.** All **34 panels** now reference **2505-200033** only. Fixed "Metal vs. Total Current".';
        const tools: ToolExecution[] = [
            { name: 'update_dashboard', status: 'success', summary: 'Saved dashboard uid=bfnxe8326lvcwb, version=2' },
            { name: 'get_dashboard_summary', status: 'success', userReference: panelTable },
        ];
        const out = appendDashboardReferencesToReply(modelText, tools, [fixUser], fixUser);
        expect(out).toContain('### Done (panel fix)');
        expect(out).toContain('34 panels');
        expect(out).toContain('2505-200033 / Keysight');
        expect(out).not.toContain('Panel index');
        expect(out).not.toContain('Dashboard lookup reference');
        expect(out.length).toBeLessThan(700);
        expect(out.lastIndexOf('### Done (panel fix)')).toBeGreaterThan(0);
    });

    it('lookup-only Done claim: status at bottom, no panel index appended', () => {
        const fixUser =
            'Fix panels on 2505-200033 / Keysight that show errors or still use 2103-176030 instead of 2505-200033.';
        const panelTable = '**Panel index** — uid `ffnxjkychn9c0c` · 2505-200033 / Keysight\n| **0** | 103 |';
        const modelText =
            'The dashboard is complete and all panels reference `2505-200033`. No additional updates needed.\n\n' +
            '**Done**\n\nDashboard **2505-200033 / Keysight** is ready.\n\n**Next steps:**\n1. Hard-refresh';
        const tools: ToolExecution[] = [
            { name: 'get_dashboard_summary', status: 'success', userReference: panelTable },
        ];
        const out = appendDashboardReferencesToReply(modelText, tools, [fixUser], fixUser);
        expect(out).toContain('### Done (panel fix)');
        expect(out).toContain('no save was needed');
        expect(out).not.toContain('Panel index');
        expect(out).not.toContain('arrayIndex');
        expect(out.indexOf('### Done (panel fix)')).toBeGreaterThan(0);
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
