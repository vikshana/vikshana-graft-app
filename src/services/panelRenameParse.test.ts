import {
    messageDescribesPanelRename,
    parsePanelRenameRequest,
    userWantsPanelRename,
} from './panelRenameParse';
import {
    messageDescribesDashboardRename,
    parseDashboardRenameRequest,
    userWantsDashboardRename,
} from './dashboardRenameParse';

describe('panelRenameParse', () => {
    const pressureGauge =
        'Rename the "Pressure Gauge" panel to "System Pressure" on dashboard UID = cfo0wckufbdhce.';

    it('parses the reported user prompt', () => {
        const req = parsePanelRenameRequest(pressureGauge);
        expect(req).not.toBeNull();
        expect(req?.currentPanelTitle).toBe('Pressure Gauge');
        expect(req?.newPanelTitle).toBe('System Pressure');
        expect(req?.dashboardUid).toBe('cfo0wckufbdhce');
        expect(userWantsPanelRename(pressureGauge)).toBe(true);
        expect(messageDescribesPanelRename(pressureGauge)).toBe(true);
    });

    it('parses unquoted panel title variant', () => {
        const req = parsePanelRenameRequest(
            'Rename the Pressure panel to System on dashboard uid=abc123xyz'
        );
        expect(req).not.toBeNull();
        expect(req?.currentPanelTitle).toBe('Pressure');
        expect(req?.newPanelTitle).toBe('System');
        expect(req?.dashboardUid).toBe('abc123xyz');
    });

    it('parses change-the-name phrasing (Skywater Levels → Machine Levels)', () => {
        const prompt =
            'Change the name of the "Levels" panel to "Machine Levels" on the dashboard with UID = idHkqdqnkmfv.';
        const req = parsePanelRenameRequest(prompt);
        expect(req).not.toBeNull();
        expect(req?.currentPanelTitle).toBe('Levels');
        expect(req?.newPanelTitle).toBe('Machine Levels');
        expect(req?.dashboardUid).toBe('idHkqdqnkmfv');
        expect(messageDescribesPanelRename(prompt)).toBe(true);
        expect(userWantsPanelRename(prompt)).toBe(true);
    });

    it('parses rename panel titled phrasing', () => {
        const req = parsePanelRenameRequest(
            'Rename panel titled "Old Name" to "New Name" on dashboard uid=deadbeef01'
        );
        expect(req).not.toBeNull();
        expect(req?.currentPanelTitle).toBe('Old Name');
        expect(req?.newPanelTitle).toBe('New Name');
    });

    it('does not treat panel rename as dashboard rename', () => {
        expect(messageDescribesDashboardRename(pressureGauge)).toBe(false);
        expect(parseDashboardRenameRequest(pressureGauge)).toBeNull();
        expect(userWantsDashboardRename(pressureGauge)).toBe(false);
    });
});
