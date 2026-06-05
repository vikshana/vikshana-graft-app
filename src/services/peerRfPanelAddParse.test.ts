import {
    formatAddPeerRfPanelExamplePrompt,
    messageMentionsAddPeerRfPanel,
    parseAddPeerRfPanelRequest,
} from './peerRfPanelAddParse';

describe('peerRfPanelAddParse', () => {
    it('parses add peer RF panel prompt', () => {
        const prompt = formatAddPeerRfPanelExamplePrompt('6gawrgawrgragg');
        expect(parseAddPeerRfPanelRequest(prompt)).toEqual({
            dashboardUid: '6gawrgawrgragg',
            dashboardTitle: undefined,
            machineId: undefined,
        });
        expect(messageMentionsAddPeerRfPanel(prompt)).toBe(true);
    });
});
