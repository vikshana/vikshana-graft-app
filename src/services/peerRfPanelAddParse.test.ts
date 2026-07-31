import {
    formatAddPeerRfPanelExamplePrompt,
    messageMentionsAddPeerRfPanel,
    parseAddPeerRfPanelRequest,
    peerRfPanelTitle,
} from './peerRfPanelAddParse';

describe('peerRfPanelAddParse', () => {
    it('parses add peer RF panel prompt', () => {
        const prompt = formatAddPeerRfPanelExamplePrompt('6gawrgawrgragg');
        expect(parseAddPeerRfPanelRequest(prompt)).toEqual({
            dashboardUid: '6gawrgawrgragg',
            dashboardTitle: undefined,
            machineId: undefined,
            moduleNumber: 5,
            enrollIfMissing: false,
        });
        expect(messageMentionsAddPeerRfPanel(prompt)).toBe(true);
    });

    it('honors the requested module instead of defaulting to Module 5', () => {
        const prompt =
            'Create a RandomForest vs Peers (Influx) machine learning panel for Module 3 Current for the dashboard with UID = afq7tc6hl1m9sb.';
        const req = parseAddPeerRfPanelRequest(prompt);
        expect(req?.dashboardUid).toBe('afq7tc6hl1m9sb');
        expect(req?.moduleNumber).toBe(3);
    });

    it('builds a module-scoped title', () => {
        expect(peerRfPanelTitle(3)).toBe('Module 3 Current — RandomForest vs Peers (Influx)');
        expect(peerRfPanelTitle(5)).toBe('Module 5 Current — RandomForest vs Peers (Influx)');
    });
});
