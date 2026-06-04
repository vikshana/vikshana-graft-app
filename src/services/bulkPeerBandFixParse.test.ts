import { parseScopedPanelFixRequest } from './panelFixScope';
import {
    BULK_PEER_BAND_DEFAULT_TITLE_FILTER,
    BULK_PEER_BAND_FIX_EXAMPLE_PROMPT,
    formatBulkPeerBandFixExamplePrompt,
    parseBulkPeerBandFixRequest,
    userWantsBulkPeerBandFix,
} from './bulkPeerBandFixParse';

describe('formatBulkPeerBandFixExamplePrompt', () => {
    it('uses plain English without internal jargon', () => {
        expect(formatBulkPeerBandFixExamplePrompt('abc123')).toContain('fix all panels whose title contains');
        expect(formatBulkPeerBandFixExamplePrompt('abc123')).toContain('vs. Peer Band');
        expect(formatBulkPeerBandFixExamplePrompt('abc123')).not.toMatch(/peer-band fix/i);
    });
});

describe('parseBulkPeerBandFixRequest', () => {
    it('parses the recommended plain-English example prompt', () => {
        expect(parseBulkPeerBandFixRequest(BULK_PEER_BAND_FIX_EXAMPLE_PROMPT)).toEqual({
            dashboardUid: '6gawrgawrgragg',
            titleContains: BULK_PEER_BAND_DEFAULT_TITLE_FILTER,
        });
    });

    it('parses casual phrasing without "peer band fix"', () => {
        const casual =
            'Dashboard uid 6gawrgawrgragg — copy the Module 5 query fix to all other vs. Peer Band panels';
        expect(parseBulkPeerBandFixRequest(casual)).toEqual({
            dashboardUid: '6gawrgawrgragg',
            titleContains: BULK_PEER_BAND_DEFAULT_TITLE_FILTER,
        });
    });

    it('parses fix all with quoted title substring', () => {
        const custom = 'Fix all panels on dashboard uid abcdef123456 with "Module 3 vs Peer" in the title';
        expect(parseBulkPeerBandFixRequest(custom)).toEqual({
            dashboardUid: 'abcdef123456',
            titleContains: 'Module 3 vs Peer',
        });
    });

    it('parses every panel whose title contains phrasing', () => {
        const natural =
            'On dashboard uid 6gawrgawrgragg, fix every panel whose title contains "vs. Peer Band" the same way as Module 5';
        expect(parseBulkPeerBandFixRequest(natural)).toEqual({
            dashboardUid: '6gawrgawrgragg',
            titleContains: 'vs. Peer Band',
        });
    });

    it('returns null for single-panel scoped fix', () => {
        const scoped =
            'Fix only panel named "Module 5 Current — vs. Peer Band (Modules 1–4,6–8 Avg ± 2σ)" on dashboard uid 6gawrgawrgragg';
        expect(parseBulkPeerBandFixRequest(scoped)).toBeNull();
    });

    it('returns null without dashboard uid', () => {
        expect(parseBulkPeerBandFixRequest('fix all vs. Peer Band panels like Module 5')).toBeNull();
    });
});

describe('userWantsBulkPeerBandFix', () => {
    it('matches recommended example prompt', () => {
        expect(userWantsBulkPeerBandFix(BULK_PEER_BAND_FIX_EXAMPLE_PROMPT)).toBe(true);
    });
});

describe('scoped vs bulk routing', () => {
    it('does not treat bulk all-panels message as scoped single-panel fix', () => {
        expect(parseScopedPanelFixRequest(BULK_PEER_BAND_FIX_EXAMPLE_PROMPT)).toBeNull();
    });
});
