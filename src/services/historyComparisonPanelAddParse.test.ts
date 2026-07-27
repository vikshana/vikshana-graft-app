import {
    formatAddHistoryComparisonPanelExamplePrompt,
    messageMentionsPredictiveAnalyticsPanel,
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
        expect(parseAddHistoryComparisonPanelRequest(userPrompt)).toEqual({
            dashboardUid: 'afq7tc6hl1m9sb',
            dashboardTitle: undefined,
            titleLabel: undefined,
            machineId: undefined,
            moduleNumber: 2,
        });
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
