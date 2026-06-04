import {
    computeRenamedDashboardTitle,
    formatDashboardRenameNotFoundClarification,
    parseDashboardRenameRequest,
    userWantsDashboardRename,
} from './dashboardRenameParse';

describe('dashboardRenameParse', () => {
    const employee =
        'Rename the dashboard for the 2505-200033 machine to be NewMachine instead of Keysight';

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
