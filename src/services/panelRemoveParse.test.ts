import {
    messageDescribesPanelRemove,
    parsePanelRemoveRequest,
    userWantsPanelRemove,
} from './panelRemoveParse';

describe('panelRemoveParse', () => {
    it('parses remove the Cartridge Happiness Panel with context uid', () => {
        expect(messageDescribesPanelRemove('remove the Cartridge Happiness Panel.')).toBe(true);
        const req = parsePanelRemoveRequest('remove the Cartridge Happiness Panel.', {
            contextDashboardUid: 'cfo0wckufbdhce',
        });
        expect(req).toEqual({
            panelTitle: 'Cartridge Happiness',
            dashboardUid: 'cfo0wckufbdhce',
            machineId: undefined,
        });
        expect(userWantsPanelRemove('remove the Cartridge Happiness Panel.', 'cfo0wckufbdhce')).toBe(
            true
        );
    });

    it('parses quoted panel title with explicit uid', () => {
        const req = parsePanelRemoveRequest(
            'Remove the "Cartridge Happiness Score" panel on dashboard uid=cfo0wckufbdhce'
        );
        expect(req?.panelTitle).toBe('Cartridge Happiness Score');
        expect(req?.dashboardUid).toBe('cfo0wckufbdhce');
    });

    it('requires dashboard uid or context', () => {
        expect(parsePanelRemoveRequest('remove the Foo panel')).toBeNull();
    });
});
