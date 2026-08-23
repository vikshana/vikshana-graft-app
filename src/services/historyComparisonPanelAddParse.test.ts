import {
    formatAddHistoryComparisonPanelExamplePrompt,
    formatHistoryComparisonSignalClarification,
    messageMentionsPredictiveAnalyticsPanel,
    messageNeedsHistoryComparisonSignalClarification,
    parseAddHistoryComparisonPanelRequest,
} from './historyComparisonPanelAddParse';
import { canonicalLiveHistoryComparisonTitle } from './modulePanelTitles';

describe('historyComparisonPanelAddParse', () => {
    const userPrompt =
        'Create a predictive analytics panel for Module 2 Current on the dashboard with UID = afq7tc6hl1m9sb.';

    it('detects predictive analytics panel intent', () => {
        expect(messageMentionsPredictiveAnalyticsPanel(userPrompt)).toBe(true);
    });

    it('parses module 2 and dashboard uid from the Keysight prompt', () => {
        const req = parseAddHistoryComparisonPanelRequest(userPrompt);
        expect(req).toMatchObject({
            dashboardUid: 'afq7tc6hl1m9sb',
            dashboardTitle: undefined,
            titleLabel: undefined,
            machineId: undefined,
            moduleNumber: 2,
        });
        expect(req?.signal?.field).toBe('Module2_Current_A');
        expect(req?.signal?.panelTitle).toBe('Module 2 Current — History Comparison');
    });

    it('parses Keysight label when no uid is given', () => {
        expect(
            parseAddHistoryComparisonPanelRequest(
                'Create a predictive analytics panel for Module 1 Current on the Keysight dashboard.'
            )
        ).toMatchObject({
            titleLabel: 'Keysight',
            moduleNumber: 1,
        });
    });

    it('parses Random Forest sensing-voltage prompts (not Module 5 Current)', () => {
        const prompt =
            'Create a Random Forest machine learning panel for sensing voltage on the dashboard with UID = afq7tc6hl1m9sb.';
        expect(messageMentionsPredictiveAnalyticsPanel(prompt)).toBe(true);
        const req = parseAddHistoryComparisonPanelRequest(prompt);
        expect(req?.dashboardUid).toBe('afq7tc6hl1m9sb');
        expect(req?.metricLabel).toBe('sensing voltage');
        expect(req?.moduleNumber).toBeUndefined();
        expect(req?.signal?.field).toBe('Cartridge_Sensing_Voltage');
        expect(req?.signal?.panelTitle).toBe('Sensing Voltage — History Comparison');
        expect(req?.signal?.unit).toBe('volt');
    });

    it('parses Module 2 Voltage Random Forest prompts (not Module 2 Current)', () => {
        const prompt =
            'Create a Random Forest machine learning panel for Module 2 Voltage on the dashboard with UID = afq7tc6hl1m9sb.';
        const req = parseAddHistoryComparisonPanelRequest(prompt);
        expect(req?.signal?.field).toBe('Module2_Voltage_VDC');
        expect(req?.signal?.panelTitle).toBe('Module 2 Voltage — History Comparison');
        expect(req?.signal?.unit).toBe('volt');
        expect(req?.moduleNumber).toBe(2);
    });

    it('clarifies bare pressure RF creates instead of defaulting to Module 5', () => {
        const prompt =
            'Create a Random Forest machine learning panel for pressure on the dashboard with UID = afq7tc6hl1m9sb.';
        expect(messageMentionsPredictiveAnalyticsPanel(prompt)).toBe(true);
        expect(parseAddHistoryComparisonPanelRequest(prompt)).toBeNull();
        expect(messageNeedsHistoryComparisonSignalClarification(prompt)).toBe(true);
        const reply = formatHistoryComparisonSignalClarification(prompt);
        expect(reply).toContain('Need a clearer Random Forest signal');
        expect(reply).toContain('pressure');
        expect(reply).toContain('Own History');
        expect(reply).not.toContain('Module 5 Current — History Comparison');
    });

    it('does not treat machine learning as a dashboard titleLabel', () => {
        const prompt =
            'Create a Random Forest machine learning panel for sensing voltage on the dashboard with UID = afq7tc6hl1m9sb.';
        expect(parseAddHistoryComparisonPanelRequest(prompt)?.titleLabel).toBeUndefined();
    });

    it('does not steal own-history or peer-RF prompts', () => {
        expect(
            messageMentionsPredictiveAnalyticsPanel(
                'Create a vs. Own History (±2σ) machine learning panel for Pressure on the dashboard with UID = afq7tc6hl1m9sb.'
            )
        ).toBe(false);
        expect(
            messageMentionsPredictiveAnalyticsPanel(
                'Create a RandomForest vs Peers (Influx) machine learning panel for Module 3 Current for the dashboard with UID = afq7tc6hl1m9sb.'
            )
        ).toBe(false);
    });

    it('does not steal Peer Band ±2σ machine-learning create prompts', () => {
        const peerBand =
            'Create a new machine learning time series panel titled "Module 2 Current — Alert Test Peer Band ±2σ" on the dashboard with UID afq7tc6hl1m9sb. Compare Module 2 Current against the average of Modules 1 and 3 through 8. Create four visible lines: Module 2 Actual Peer Mean Upper Peer Bound (Peer Mean + 2 × Standard Deviation) Lower Peer Bound (Peer Mean - 2 × Standard Deviation) Calculate the Upper and Lower Peer Bounds in the Flux query itself.';
        expect(messageMentionsPredictiveAnalyticsPanel(peerBand)).toBe(false);
        expect(parseAddHistoryComparisonPanelRequest(peerBand)).toBeNull();
    });

    it('builds canonical live history comparison title', () => {
        expect(canonicalLiveHistoryComparisonTitle(2)).toBe('Module 2 Current — History Comparison');
    });

    it('formats educational guidance instead of a bare technical prompt', () => {
        const msg = formatAddHistoryComparisonPanelExamplePrompt(2, 'afq7tc6hl1m9sb');
        expect(msg).toContain('Machine learning panels');
        expect(msg).toContain('Module 2 Current');
    });
});
