import { parseScopedPanelFixRequest } from './panelFixScope';
import { parseBulkPeerBandFixRequest } from './bulkPeerBandFixParse';
import { userWantsDashboardClone } from './dashboardCloneProgress';
import {
    diagnosePeerBandPanelCopyGaps,
    extractSourceDashboardUid,
    extractTargetDashboardUids,
    messageMentionsPeerBandPanelCopyIntent,
    parsePeerBandPanelCopyRequest,
    userWantsPeerBandPanelCopy,
} from './peerBandPanelCopyParse';

describe('peerBandPanelCopyParse', () => {
    const userPrompt =
        'Copy all panels whose title contains "vs. Peer Band" from dashboard uid="6gawrgawrgragg"  to dashboard uid="bfo0v59rxtou8e". ' +
        'Remap those copied panels to machine 2505-200033. Verify the results afterwards that all the "vs. Peer Band"  panels in uid="bfo0v59rxtou8e" are properly working';

    const multiTarget =
        'Copy all panels whose title contains "vs. Peer Band" from dashboard uid sourceabc to dashboard uid target1, to dashboard uid target2. ' +
        'Copy from 2406-176021 with data for 2505-200033 on target1.';

    it('parses uid="..." syntax with remap and verify', () => {
        expect(messageMentionsPeerBandPanelCopyIntent(userPrompt)).toBe(true);
        const req = parsePeerBandPanelCopyRequest(userPrompt);
        expect(req).not.toBeNull();
        expect(req?.sourceDashboardUid).toBe('6gawrgawrgragg');
        expect(req?.targetDashboardUids).toEqual(['bfo0v59rxtou8e']);
        expect(req?.titleContains).toBe('vs. Peer Band');
        expect(req?.targetMachineId).toBe('2505-200033');
        expect(req?.verifyAfterSave).toBe(true);
    });

    it('extracts uids from equals-quoted phrasing', () => {
        expect(extractSourceDashboardUid(userPrompt)).toBe('6gawrgawrgragg');
        expect(extractTargetDashboardUids(userPrompt, '6gawrgawrgragg')).toEqual(['bfo0v59rxtou8e']);
    });

    it('parses multi-target example', () => {
        const req = parsePeerBandPanelCopyRequest(multiTarget);
        expect(req?.sourceDashboardUid).toBe('sourceabc');
        expect(req?.targetDashboardUids).toEqual(expect.arrayContaining(['target1', 'target2']));
    });

    it('does not collide with bulk peer-band fix or scoped fix', () => {
        expect(userWantsPeerBandPanelCopy(userPrompt)).toBe(true);
        expect(parseBulkPeerBandFixRequest(userPrompt)).toBeNull();
        expect(parseScopedPanelFixRequest(userPrompt)).toBeNull();
    });

    it('does not treat panel copy as full dashboard clone', () => {
        expect(userWantsDashboardClone(userPrompt)).toBe(false);
    });

    it('reports gaps when target uid is missing', () => {
        const vague = 'Copy all vs. Peer Band panels from dashboard uid="aaa"';
        expect(parsePeerBandPanelCopyRequest(vague)).toBeNull();
        expect(diagnosePeerBandPanelCopyGaps(vague)).toContain('**Target dashboard uid**');
    });
});
