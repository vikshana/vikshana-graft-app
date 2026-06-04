/** Shorter title substring — matches every "Module N … vs. Peer Band …" panel. */
export const BULK_PEER_BAND_DEFAULT_TITLE_FILTER = 'vs. Peer Band';

/**
 * Lightweight cross-dashboard copy intent (no parser imports).
 * Used to break circular deps between bulkPeerBandFixParse and peerBandPanelCopyParse.
 */
export function isCrossDashboardPeerBandCopyIntent(message: string): boolean {
    const text = message.trim();
    if (!text) {
        return false;
    }
    const hasPeer =
        /\bpeer\s*band\b/i.test(text) ||
        /\bvs\.?\s*peer\b/i.test(text) ||
        /Peer Band \(Modules/i.test(text) ||
        (/\btitle\s+contains\b/i.test(text) && /\b(peer|band)\b/i.test(text));
    const hasCopy =
        /\b(copy|transplant|transfer)\b/i.test(text) && /\bpanel/i.test(text) && /\bfrom\b/i.test(text);
    const hasTargets =
        /\bto\b[^.\n]{0,80}?\buid\b/i.test(text) ||
        /\binto\b[^.\n]{0,80}?\buid\b/i.test(text);
    return hasPeer && hasCopy && hasTargets;
}
