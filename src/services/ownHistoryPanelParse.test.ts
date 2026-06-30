import {
    extractOwnHistoryMetricLabel,
    parseAddOwnHistoryPanelRequest,
} from './ownHistoryPanelParse';

describe('ownHistoryPanelParse — target metric', () => {
    it('extracts a named signal from the prompt', () => {
        expect(
            extractOwnHistoryMetricLabel(
                'Create a vs. Own History (±2σ) machine learning panel for Pressure on the dashboard with UID = afq7tc6hl1m9sb.'
            )
        ).toBe('Pressure');
    });

    it('extracts a module-current phrase', () => {
        expect(
            extractOwnHistoryMetricLabel(
                'Create a vs. Own History (±2σ) panel for Module 3 Current for the dashboard with UID = afq7tc6hl1m9sb.'
            )
        ).toBe('Module 3 Current');
    });

    it('routes a non-module metric to metricLabel (not Module 5)', () => {
        const req = parseAddOwnHistoryPanelRequest(
            'Create a vs. Own History (±2σ) machine learning panel for Pressure on the dashboard with UID = afq7tc6hl1m9sb.'
        );
        expect(req?.dashboardUid).toBe('afq7tc6hl1m9sb');
        expect(req?.metricLabel).toBe('Pressure');
        expect(req?.moduleNumber).toBeUndefined();
    });

    it('routes a module current to moduleNumber', () => {
        const req = parseAddOwnHistoryPanelRequest(
            'Create a vs. Own History (±2σ) panel for Module 3 Current for the dashboard with UID = afq7tc6hl1m9sb.'
        );
        expect(req?.moduleNumber).toBe(3);
        expect(req?.metricLabel).toBeUndefined();
    });

    it('falls back to Module 5 when no target is named', () => {
        const req = parseAddOwnHistoryPanelRequest(
            'Add a vs. Own History (±2σ) panel on the dashboard with UID = afq7tc6hl1m9sb.'
        );
        expect(req?.moduleNumber).toBe(5);
        expect(req?.metricLabel).toBeUndefined();
    });
});
