import {
    computeRenamedDashboardTitle,
    formatDashboardRenameNotFoundClarification,
    messageDescribesDashboardRename,
    parseDashboardRenameRequest,
    userWantsDashboardRename,
} from './dashboardRenameParse';

describe('dashboardRenameParse', () => {
    const employee =
        'Rename the dashboard for the 2505-200033 machine to be NewMachine instead of Keysight';
    const panelRename =
        'Rename the "Pressure Gauge" panel to "System Pressure" on dashboard UID = cfo0wckufbdhce.';

    it('rejects panel rename prompt', () => {
        expect(messageDescribesDashboardRename(panelRename)).toBe(false);
        expect(parseDashboardRenameRequest(panelRename)).toBeNull();
        expect(userWantsDashboardRename(panelRename)).toBe(false);
    });

    it('parses machine rename phrasing', () => {
        const req = parseDashboardRenameRequest(employee);
        expect(req).not.toBeNull();
        expect(req?.machineId).toBe('2505-200033');
        expect(req?.newLabel).toBe('NewMachine');
        expect(req?.replaceLabel).toBe('Keysight');
        expect(userWantsDashboardRename(employee)).toBe(true);
    });

    it('computes new dashboard title', () => {
        expect(
            computeRenamedDashboardTitle('2505-200033 / Keysight', {
                machineId: '2505-200033',
                replaceLabel: 'Keysight',
                newLabel: 'NewMachine',
            })
        ).toBe('2505-200033 / NewMachine');
    });

    // Regression (build 174): `Rename ... to be "Keysight"` renamed the dashboard to "be".
    // The quoted name must win over the "be" connector word.
    it('extracts the quoted name from a "to be \\"X\\"" rename (not the word "be")', () => {
        const prompt = 'Rename the dashboard with UID = cfq1987ycwq2oc to be "Keysight".';
        const req = parseDashboardRenameRequest(prompt);
        expect(req).not.toBeNull();
        expect(req?.dashboardUid).toBe('cfq1987ycwq2oc');
        expect(req?.newLabel).toBe('Keysight');
        expect(req?.newLabel).not.toBe('be');
        expect(
            computeRenamedDashboardTitle('2505-200033 / GlenTest', {
                newLabel: req!.newLabel,
                newTitle: req!.newTitle,
            })
        ).toBe('2505-200033 / Keysight');
    });

    it('extracts the quoted name from a plain "to \\"X\\"" rename', () => {
        const req = parseDashboardRenameRequest(
            'Rename the dashboard with UID = abc123 to "Keysight".'
        );
        expect(req?.newLabel).toBe('Keysight');
    });

    it('still parses the unquoted "to be NewLabel" form', () => {
        const req = parseDashboardRenameRequest(
            'Rename the dashboard with UID = abc123 to be Keysight'
        );
        expect(req?.newLabel).toBe('Keysight');
    });

    it('formats not-found clarification with understood intent', () => {
        const req = parseDashboardRenameRequest(employee);
        expect(req).not.toBeNull();
        const msg = formatDashboardRenameNotFoundClarification(req!, {
            searchedQueries: ['2505-200033 / Keysight', '2505-200033'],
        });
        expect(msg).toContain('Need clarification');
        expect(msg).toContain('2505-200033');
        expect(msg).toContain('Keysight');
        expect(msg).toContain('NewMachine');
    });
});
