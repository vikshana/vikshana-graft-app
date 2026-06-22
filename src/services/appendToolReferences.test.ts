import {
    appendDashboardReferencesToReply,
    appendSaveVerificationWarning,
    claimsDashboardSaveWithoutTool,
} from './appendToolReferences';
import type { ToolExecution } from '../types/llm.types';

describe('appendToolReferences', () => {
    const panelTable = '**Panel index** — uid `abc`';

    it('strips panel index on lookup-only instead of appending full tables', () => {
        const tools: ToolExecution[] = [{ name: 'get_dashboard_summary', status: 'success', userReference: panelTable }];
        const out = appendDashboardReferencesToReply('Done!', tools);
        expect(out).not.toContain('arrayIndex');
        expect(out).not.toContain('**Panel index**');
        expect(out).toBe('Done!');
    });

    it('strips embedded panel index from model reply without duplicating', () => {
        const tools: ToolExecution[] = [{ name: 'get_dashboard_summary', status: 'success', userReference: panelTable }];
        const out = appendDashboardReferencesToReply('See Panel index below\n\n' + panelTable, tools);
        expect(out).not.toContain('arrayIndex');
        expect(out).toContain('See Panel index below');
    });

    it('blocks misleading dashboard saved reply for panel rename prompts', () => {
        const user =
            'Rename the "Pressure Gauge" panel to "System Pressure" on dashboard UID = cfo0wckufbdhce.';
        const tools: ToolExecution[] = [
            {
                name: 'update_dashboard',
                status: 'success' as const,
                summary: 'Saved dashboard uid=cfo0wckufbdhce, version=76',
            },
        ];
        const out = appendDashboardReferencesToReply('Done.', tools, [user], user);
        expect(out).toContain('Panel rename should be programmatic');
        expect(out).not.toContain('### Done (dashboard saved)');
        expect(out).not.toContain('Dashboard renamed and saved');
    });

    it('uses concise dashboard saved reply for any successful update_dashboard', () => {
        // Dashboard-level change (no "panel" word, no panel-index table) → generic
        // dashboard-saved reply, not the panel-fix reply.
        const user = 'Update the default time range on 2505-200033 / Keysight dashboard';
        const modelText = 'Updated the dashboard.';
        const tools: ToolExecution[] = [
            {
                name: 'update_dashboard',
                status: 'success' as const,
                summary: 'Saved dashboard uid=abc123, version=5',
            },
        ];
        const out = appendDashboardReferencesToReply(modelText, tools, [user], user);
        expect(out).toContain('### Done (dashboard saved)');
        expect(out).not.toContain('Panel index');
        expect(out).toContain('version **5**');
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
        expect(out).toContain('No save was needed');
        expect(out).not.toContain('Panel index');
        expect(out).not.toContain('arrayIndex');
        expect(out.indexOf('### Done (panel fix)')).toBeGreaterThan(0);
    });

    it('uses concise panel create reply with summary at end, no index tables', () => {
        const createUser =
            'Please create a new pressure gauge panel for the dashboard of 2505-200033 (NewMachine).';
        const panelTable = '**Panel index** — uid `cfo0wckufbdhce`';
        const modelText =
            '✅ New pressure gauge panel created and saved.\n\n- **Panel title:** Pressure - NewMachine\n- **Panel ID:** 102\n\n' +
            panelTable;
        const tools = [
            {
                name: 'update_dashboard',
                status: 'success' as const,
                summary: 'Saved dashboard uid=cfo0wckufbdhce, version=19',
            },
            { name: 'get_dashboard_summary', status: 'success' as const, userReference: panelTable },
        ];
        const out = appendDashboardReferencesToReply(modelText, tools, [createUser], createUser);
        expect(out).toContain('### Done (panel added)');
        expect(out).not.toContain('Panel index');
        expect(out.lastIndexOf('Hard-refresh')).toBeGreaterThan(out.indexOf('### Done (panel added)'));
    });

    it('adds compact lookup hint after search without appending panel index', () => {
        const searchRef =
            '**Dashboard lookup reference**\n| 1 | 2505-200033 / Keysight | `abc123` | — |';
        const tools: ToolExecution[] = [
            { name: 'search_dashboards', status: 'success', userReference: searchRef },
        ];
        const out = appendDashboardReferencesToReply('Found your dashboard.', tools);
        expect(out).toContain('Dashboards found');
        expect(out).toContain('abc123');
        expect(out).not.toContain('Panel index');
        expect(out).not.toContain('arrayIndex');
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

    it('does NOT append a save/continue warning on a read-only search turn', () => {
        const tools: ToolExecution[] = [{ name: 'search_dashboards', status: 'success' as const }];
        const reply = 'Here are the dashboards I found. Would you like me to open one of them?';
        const out = appendSaveVerificationWarning(
            reply,
            tools,
            ['Search the dashboards on this Grafana and list their titles'],
            'Search the dashboards on this Grafana and list their titles'
        );
        expect(out).toBe(reply);
        expect(out).not.toMatch(/Continue|before saving|No confirmed/i);
    });
});
