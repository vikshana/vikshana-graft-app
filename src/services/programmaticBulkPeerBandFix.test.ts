import { formatBulkPeerBandFixReply } from './programmaticBulkPeerBandFix';

describe('formatBulkPeerBandFixReply', () => {
    it('reports done with panel counts', () => {
        const text = formatBulkPeerBandFixReply(
            {
                ok: true,
                toolExecutions: [],
                panelsMatched: 8,
                panelsChanged: 8,
                targetsFixed: 32,
                panelResults: [],
                verificationNote: '**Saved:** 8 panels on version **225**.',
            },
            127
        );
        expect(text).toContain('### Done (vs. Peer Band panels updated)');
        expect(text).toContain('8 of 8 matched');
        expect(text).toContain('32');
    });

    it('reports failure without done heading', () => {
        const text = formatBulkPeerBandFixReply(
            {
                ok: false,
                error: 'No panels matched',
                toolExecutions: [],
                panelsMatched: 0,
                panelsChanged: 0,
                targetsFixed: 0,
                panelResults: [],
            },
            127
        );
        expect(text).toContain('### Could not update');
        expect(text).not.toContain('### Done');
    });
});
