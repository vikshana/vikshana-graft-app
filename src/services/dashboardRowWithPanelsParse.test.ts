import {
    messageDescribesDashboardRowWithPanels,
    parseDashboardRowWithPanelsRequest,
} from './dashboardRowWithPanelsParse';
import { userWantsPanelCreate } from './dashboardPanelCreateReply';

describe('dashboardRowWithPanelsParse', () => {
    const prompt =
        'Create a dashboard row called "Machine Health" and add two panels to it for dashboard with UID = cfo0wckufbdhce.';

    it('detects row with panels create intent', () => {
        expect(messageDescribesDashboardRowWithPanels(prompt)).toBe(true);
        expect(parseDashboardRowWithPanelsRequest(prompt)).toEqual({
            rowTitle: 'Machine Health',
            panelCount: 2,
            dashboardUid: 'cfo0wckufbdhce',
            machineId: undefined,
        });
    });

    it('does not match LLM panel-create reply heuristic', () => {
        expect(userWantsPanelCreate(prompt)).toBe(false);
    });
});
