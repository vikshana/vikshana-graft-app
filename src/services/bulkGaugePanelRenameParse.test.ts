import {
    messageDescribesBulkGaugePanelRename,
    parseBulkGaugePanelRenameRequest,
} from './bulkGaugePanelRenameParse';
import {
    messageDescribesDashboardRename,
    userWantsDashboardRename,
} from './dashboardRenameParse';

describe('bulkGaugePanelRenameParse', () => {
    const prompt =
        'Rename all gauge panels to begin with "System" for dashboard with UID = cfo0wckufbdhce.';

    it('detects bulk gauge panel rename intent', () => {
        expect(messageDescribesBulkGaugePanelRename(prompt)).toBe(true);
        expect(parseBulkGaugePanelRenameRequest(prompt)).toEqual({
            titlePrefix: 'System',
            dashboardUid: 'cfo0wckufbdhce',
            machineId: undefined,
        });
    });

    it('does not route to dashboard rename', () => {
        expect(messageDescribesDashboardRename(prompt)).toBe(false);
        expect(userWantsDashboardRename(prompt)).toBe(false);
    });
});
