import {
    extractPanelTitleFromCopyMessage,
    extractSourceMachineIdForPanelCopy,
    extractTargetMachineIdForPanelCopy,
    formatSinglePanelCopyExamplePrompt,
    messageMentionsSinglePanelCopyIntent,
    parseSinglePanelCopyRequest,
    userWantsSinglePanelCopy,
} from './singlePanelCopyParse';

describe('singlePanelCopyParse', () => {
    const userPrompt =
        'Create a new panel on the 2505-200033 dashboard that is the same as the "Pressure" panel on 2210-177097 but with data for 2505-200033';

    it('detects single-panel copy intent', () => {
        expect(messageMentionsSinglePanelCopyIntent(userPrompt)).toBe(true);
    });

    it('parses panel title and machine ids', () => {
        expect(extractPanelTitleFromCopyMessage(userPrompt)).toBe('Pressure');
        expect(extractSourceMachineIdForPanelCopy(userPrompt)).toBe('2210-177097');
        expect(extractTargetMachineIdForPanelCopy(userPrompt)).toBe('2505-200033');
    });

    it('builds a full request', () => {
        const req = parseSinglePanelCopyRequest(userPrompt);
        expect(req).toEqual({
            panelTitle: 'Pressure',
            sourceDashboardUid: undefined,
            targetDashboardUid: undefined,
            sourceMachineId: '2210-177097',
            targetMachineId: '2505-200033',
            replaceExisting: true,
        });
        expect(userWantsSinglePanelCopy(userPrompt)).toBe(true);
    });

    it('parses explicit dashboard uids', () => {
        const req = parseSinglePanelCopyRequest(
            'Copy panel title "Pressure" from dashboard uid ee89e3vy1nourk to dashboard uid fe89f4vy2opvsl with data for 2505-200033'
        );
        expect(req?.sourceDashboardUid).toBe('ee89e3vy1nourk');
        expect(req?.targetDashboardUid).toBe('fe89f4vy2opvsl');
        expect(req?.panelTitle).toBe('Pressure');
    });

    it('does not treat peer-band copy as single panel copy', () => {
        const peerBand =
            'Copy all panels whose title contains "vs. Peer Band" from dashboard uid="aaa" to dashboard uid="bbb" with data for 2505-200033';
        expect(messageMentionsSinglePanelCopyIntent(peerBand)).toBe(false);
    });

    it('example prompt matches parser', () => {
        const example = formatSinglePanelCopyExamplePrompt();
        expect(userWantsSinglePanelCopy(example)).toBe(true);
    });
});
