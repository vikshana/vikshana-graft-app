import {
    messageDescribesPanelCreate,
    parsePanelCreateRequest,
    userWantsPanelCreateProgrammatic,
} from './panelCreateParse';

describe('panelCreateParse', () => {
    const prompt = 'Create a bar chart panel called "Cartridge Comparison" for Keysight.';

    it('detects bar chart panel create intent', () => {
        expect(messageDescribesPanelCreate(prompt)).toBe(true);
        expect(userWantsPanelCreateProgrammatic(prompt)).toBe(true);
    });

    it('parses title, type, and keysight label', () => {
        const req = parsePanelCreateRequest(prompt);
        expect(req).toEqual({
            panelTitle: 'Cartridge Comparison',
            panelType: 'barchart',
            dashboardUid: undefined,
            titleLabel: 'keysight',
            machineId: undefined,
        });
    });

    it('parses uid when provided', () => {
        const req = parsePanelCreateRequest(
            'Create a bar chart panel called "Cartridge Comparison" on dashboard uid=cfo0wckufbdhce'
        );
        expect(req?.dashboardUid).toBe('cfo0wckufbdhce');
    });

    it('does not match bulk metric panel prompts', () => {
        expect(
            messageDescribesPanelCreate(
                'Create 50 panels covering every available metric on the dashboard with UID = cfo0wckufbdhce'
            )
        ).toBe(false);
    });
});
