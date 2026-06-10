import {
    messageDescribesMultiPanelCreate,
    messageDescribesPanelCreate,
    parseMultiPanelCreateRequest,
    parsePanelCreateRequest,
    userWantsMultiPanelCreateProgrammatic,
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

    it('detects table panel create intent for Keysight', () => {
        const prompt = 'Create a table panel called "Machine Data" for Keysight.';
        expect(messageDescribesPanelCreate(prompt)).toBe(true);
        expect(userWantsPanelCreateProgrammatic(prompt)).toBe(true);
        expect(parsePanelCreateRequest(prompt)).toEqual({
            panelTitle: 'Machine Data',
            panelType: 'table',
            dashboardUid: undefined,
            titleLabel: 'keysight',
            machineId: undefined,
        });
    });

    describe('multi panel create', () => {
        const multiPrompt =
            'Create a gauge panel, time series panel, table panel, and stat panel for dashboard with UID = cfo0wckufbdhce.';

        it('detects multi-type panel create without quoted titles', () => {
            expect(messageDescribesMultiPanelCreate(multiPrompt)).toBe(true);
            expect(messageDescribesPanelCreate(multiPrompt)).toBe(false);
            expect(userWantsMultiPanelCreateProgrammatic(multiPrompt)).toBe(true);
        });

        it('parses four panel types with default titles and dashboard uid', () => {
            expect(parseMultiPanelCreateRequest(multiPrompt)).toEqual({
                dashboardUid: 'cfo0wckufbdhce',
                titleLabel: undefined,
                machineId: undefined,
                panels: [
                    { panelType: 'gauge', panelTitle: 'Gauge Panel' },
                    { panelType: 'timeseries', panelTitle: 'Time Series Panel' },
                    { panelType: 'table', panelTitle: 'Table Panel' },
                    { panelType: 'stat', panelTitle: 'Stat Panel' },
                ],
            });
        });

        it('does not match single named panel create', () => {
            const single =
                'Create a gauge panel called "System Pressure" for dashboard with UID = cfo0wckufbdhce.';
            expect(messageDescribesMultiPanelCreate(single)).toBe(false);
            expect(messageDescribesPanelCreate(single)).toBe(true);
        });

        it('does not match bulk metric panel prompts', () => {
            expect(
                messageDescribesMultiPanelCreate(
                    'Create 50 panels covering every available metric on the dashboard with UID = cfo0wckufbdhce'
                )
            ).toBe(false);
        });

        it('uses open dashboard context when uid is omitted from the prompt', () => {
            const prompt =
                'Create a gauge panel, time series panel, table panel, and stat panel.';
            expect(messageDescribesMultiPanelCreate(prompt)).toBe(false);
            expect(
                messageDescribesMultiPanelCreate(prompt, 'cfo0wckufbdhce')
            ).toBe(true);
            expect(parseMultiPanelCreateRequest(prompt, { contextDashboardUid: 'cfo0wckufbdhce' })).toMatchObject({
                dashboardUid: 'cfo0wckufbdhce',
                panels: expect.any(Array),
            });
        });
    });
});
