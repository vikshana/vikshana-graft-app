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
            machineId: undefined,
            moduleNumber: 2,
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

    it('builds canonical live history comparison title', () => {
        expect(canonicalLiveHistoryComparisonTitle(2)).toBe('Module 2 Current — History Comparison');
    });

    it('formats an example prompt', () => {
        expect(formatAddHistoryComparisonPanelExamplePrompt(2, 'afq7tc6hl1m9sb')).toContain('Module 2 Current');
    });
});
