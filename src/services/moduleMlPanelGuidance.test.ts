import {
    formatModuleMlPanelGuidanceReply,
    messageMentionsModuleMlTopic,
    messageRequestsMlPanelGuidance,
    parseModuleMlGuidanceContext,
} from './moduleMlPanelGuidance';
import { parseAddHistoryComparisonPanelRequest } from './historyComparisonPanelAddParse';

describe('moduleMlPanelGuidance', () => {
    const algorithmPrompt =
        'I would like to create a machine learning algorithm for Module 1 Current on the Keysight Dashboard.';

    it('detects educational ML / algorithm requests', () => {
        expect(messageMentionsModuleMlTopic(algorithmPrompt)).toBe(true);
        expect(messageRequestsMlPanelGuidance(algorithmPrompt)).toBe(true);
        expect(parseAddHistoryComparisonPanelRequest(algorithmPrompt)).toBeNull();
    });

    it('returns plain-English guidance with Module 1 and Keysight', () => {
        const reply = formatModuleMlPanelGuidanceReply(parseModuleMlGuidanceContext(algorithmPrompt));
        expect(reply).toContain('### Machine learning panels for Module 1 Current');
        expect(reply).toContain('does **not** train a new machine-learning model');
        expect(reply).toContain('Keysight');
        expect(reply).toContain('Module 1 Current — History Comparison');
        expect(reply).toContain('vs. Own History');
        expect(reply).toContain('RandomForest vs Peers');
        expect(reply).toMatch(/hard-refresh/i);
        expect(reply).not.toContain('UID = afq7tc6hl1m9sb');
    });

    it('does not treat explicit predictive analytics panel creates as guidance-only', () => {
        const createPrompt =
            'Create a predictive analytics panel for Module 2 Current on the Keysight dashboard.';
        expect(messageRequestsMlPanelGuidance(createPrompt)).toBe(false);
        expect(parseAddHistoryComparisonPanelRequest(createPrompt)?.moduleNumber).toBe(2);
        expect(parseAddHistoryComparisonPanelRequest(createPrompt)?.titleLabel).toBe('Keysight');
    });
});
