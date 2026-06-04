import {
    applyOperatorFriendlyPanelCreateReply,
    userWantsPanelCreate,
} from './dashboardPanelCreateReply';
import type { ToolExecution } from '../types/llm.types';

describe('dashboardPanelCreateReply', () => {
    const createUser =
        'Please create a new pressure gauge panel for the dashboard of 2505-200033 (NewMachine). ' +
        'I need to find the dashboard for machine 2505-200033 (NewMachine) first';

    const panelTable =
        '**Panel index** — uid `cfo0wckufbdhce` · 2505-200033 / NewMachine\n| **0** | 103 | Overview |';

    const modelText =
        '✅ New pressure gauge panel created and saved to dashboard `cfo0wckufbdhce` (2505-200033 / NewMachine)\n\n' +
        '- **Panel title:** Pressure - NewMachine\n' +
        '- **Panel ID:** 102\n' +
        '- **Type:** Gauge\n' +
        '- **Dashboard version:** 19\n\n' +
        panelTable;

    it('detects panel create intent', () => {
        expect(userWantsPanelCreate(createUser)).toBe(true);
        expect(userWantsPanelCreate('Clone dashboard 2103 to 2505')).toBe(false);
    });

    it('formats panel create with summary at end', () => {
        const tools: ToolExecution[] = [
            {
                name: 'update_dashboard',
                status: 'success',
                summary: 'Saved dashboard uid=cfo0wckufbdhce, version=19',
            },
            { name: 'get_dashboard_summary', status: 'success', userReference: panelTable },
        ];
        const out = applyOperatorFriendlyPanelCreateReply(modelText, tools, [createUser], createUser);
        expect(out).toContain('### Done (panel added)');
        expect(out).toContain('Pressure - NewMachine');
        expect(out).toContain('panel id **102**');
        expect(out).not.toContain('Panel index');
    });
});
