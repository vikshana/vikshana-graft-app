import {
    extractOwnHistoryMetricLabel,
    messageMentionsOwnHistoryPanel,
    parseAddOwnHistoryPanelRequest,
} from './ownHistoryPanelParse';
import { messageDescribesPanelCreate, parsePanelCreateRequest } from './panelCreateParse';

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

    it('does not invent Module 5 when no target is named', () => {
        const req = parseAddOwnHistoryPanelRequest(
            'Add a vs. Own History (±2σ) panel on the dashboard with UID = afq7tc6hl1m9sb.'
        );
        expect(req).toBeNull();
    });

    const alertTestPrompt =
        'Create a new time series panel titled "Module 1 Current — Alert Test Own History ±2σ" on the dashboard with UID = afq7tc6hl1m9sb. Create four visible lines: Module 1 Actual = the current value over time Historical Mean = average of Module1_Current_A Upper Bound = Historical Mean + 2 × Standard Deviation Lower Bound = Historical Mean - 2 × Standard Deviation Make sure the Upper Bound and Lower Bound are calculated in the Flux query itself, not only in the legend or panel name.';

    it('parses the Alert Test Own History titled prompt as own-history (not generic panel create)', () => {
        expect(messageMentionsOwnHistoryPanel(alertTestPrompt)).toBe(true);
        expect(messageDescribesPanelCreate(alertTestPrompt)).toBe(false);
        expect(parsePanelCreateRequest(alertTestPrompt)).toBeNull();
        const req = parseAddOwnHistoryPanelRequest(alertTestPrompt);
        expect(req?.dashboardUid).toBe('afq7tc6hl1m9sb');
        expect(req?.moduleNumber).toBe(1);
        expect(req?.panelTitle).toBe('Module 1 Current — Alert Test Own History ±2σ');
        expect(req?.metricLabel).toBeUndefined();
    });
});
