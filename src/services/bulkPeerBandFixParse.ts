import { extractDashboardUidFromMessage } from './dashboardMentionParse';
import { PEER_BAND_TITLE_MARKER } from './fluxPeerBandFix';
import { BULK_PEER_BAND_DEFAULT_TITLE_FILTER, isCrossDashboardPeerBandCopyIntent } from './peerBandShared';

export { BULK_PEER_BAND_DEFAULT_TITLE_FILTER } from './peerBandShared';

export interface BulkPeerBandFixRequest {
    dashboardUid: string;
    titleContains: string;
}

/** Plain-English prompt operators can paste into Graft (replace uid if needed). */
export function formatBulkPeerBandFixExamplePrompt(dashboardUid = '6gawrgawrgragg'): string {
    return (
        `On dashboard uid ${dashboardUid}, fix all panels whose title contains "${BULK_PEER_BAND_DEFAULT_TITLE_FILTER}". ` +
        `Use the same Flux query fix that worked on Module 5. Do not change other panels.`
    );
}

export const BULK_PEER_BAND_FIX_EXAMPLE_PROMPT = formatBulkPeerBandFixExamplePrompt();

function normalizeMessageQuotes(text: string): string {
    return text.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
}

function messageDescribesPeerBandPanels(text: string): boolean {
    return (
        /\bpeer\s*band\b/i.test(text) ||
        /\bvs\.?\s*peer\b/i.test(text) ||
        /\bpeer\s+(average|avg)\b/i.test(text) ||
        /modules\s*1\s*[–\-—]\s*4,\s*6\s*[–\-—]\s*8/i.test(text) ||
        /\b2\s*σ\b/i.test(text) ||
        /\bmodule\s*\d+\s+(current|voltage)\s*[—–-]\s*vs\b/i.test(text)
    );
}

function messageDescribesBulkPanelScope(text: string): boolean {
    if (/\bfix\s+all\b/i.test(text)) {
        return true;
    }
    if (/\b(all|every|each)\b/i.test(text) && /\bpanel/i.test(text)) {
        return true;
    }
    if (/\b(all|every|each)\b/i.test(text) && messageDescribesPeerBandPanels(text)) {
        return true;
    }
    if (/\b(same|working)\b/i.test(text) && /\b(all|every|each|other|similar|matching|rest)\b/i.test(text)) {
        return true;
    }
    if (/\bapply\b/i.test(text) && /\b(to|on)\s+(all|every|each)\b/i.test(text)) {
        return true;
    }
    if (/\bcopy\b/i.test(text) && /\b(to|onto)\s+(all|every|each|other)\b/i.test(text)) {
        return true;
    }
    if (/\bmodule\s*5\b/i.test(text) && /\b(all|other|similar|matching|rest|remaining)\b/i.test(text)) {
        return true;
    }
    return false;
}

function messageDescribesFixAction(text: string): boolean {
    return /\b(fix|repair|correct|apply|update|use|copy)\b/i.test(text);
}

function isExclusiveSinglePanelFixCommand(message: string): boolean {
    return (
        /\b(fix|ix|repair|correct)\s+only\b/i.test(message) ||
        /\bonly\s+panel\b/i.test(message) ||
        (/\bdo not change other panels?\b/i.test(message) &&
            !/\b(all|every|each)\b/i.test(message) &&
            !/\bfix\s+all\b/i.test(message))
    );
}

function extractTitleFilterFromMessage(text: string): string | undefined {
    const patterns = [
        /title\s+(?:contains|includes|matching|with)\s+"([^"]+)"/i,
        /(?:panels?\s+(?:whose\s+title\s+)?(?:contains|includes|with)|with)\s+"([^"]+)"\s+in\s+(?:the\s+)?title/i,
        /"([^"]+)"\s+in\s+(?:the\s+)?title/i,
        /(?:fix|update)\s+all\s+(?:the\s+)?"([^"]+)"/i,
        /(?:fix|update)\s+all\s+(?:the\s+)?panels?\s+(?:named|called|titled)\s+"([^"]+)"/i,
    ];
    for (const re of patterns) {
        const match = text.match(re);
        if (match?.[1]?.trim()) {
            return match[1].trim();
        }
    }
    return undefined;
}

export function parseBulkPeerBandFixRequest(message: string): BulkPeerBandFixRequest | null {
    const text = normalizeMessageQuotes(message.trim());
    if (!text) {
        return null;
    }

    if (isCrossDashboardPeerBandCopyIntent(text)) {
        return null;
    }

    const dashboardUid = extractDashboardUidFromMessage(text);
    if (!dashboardUid) {
        return null;
    }

    if (!messageDescribesPeerBandPanels(text)) {
        return null;
    }

    if (!messageDescribesBulkPanelScope(text)) {
        return null;
    }

    if (isExclusiveSinglePanelFixCommand(text) && !messageDescribesBulkPanelScope(text)) {
        return null;
    }

    if (!messageDescribesFixAction(text)) {
        return null;
    }

    const titleContains =
        extractTitleFilterFromMessage(text) ??
        (/\bvs\.?\s*peer\b/i.test(text) ? BULK_PEER_BAND_DEFAULT_TITLE_FILTER : PEER_BAND_TITLE_MARKER);

    return { dashboardUid, titleContains };
}

export function userWantsBulkPeerBandFix(message: string): boolean {
    return parseBulkPeerBandFixRequest(message) != null;
}

/** User mentioned vs. Peer Band panels but the message is too vague to run bulk fix safely. */
export function messageMentionsPeerBandPanelsButNotBulkFix(message: string): boolean {
    const text = message.trim();
    if (!text || userWantsBulkPeerBandFix(text)) {
        return false;
    }
    if (isExclusiveSinglePanelFixCommand(text)) {
        return false;
    }
    return messageDescribesPeerBandPanels(text) && /\b(fix|repair|apply|copy|update)\b/i.test(text);
}

export function formatBulkPeerBandFixClarification(dashboardUid?: string): string {
    const example = formatBulkPeerBandFixExamplePrompt(dashboardUid ?? 'YOUR_DASHBOARD_UID');
    return (
        `### Need clarification\n\n` +
        `To fix **all** of the “Module N … vs. Peer Band …” panels at once, say which dashboard and that you want **every** matching panel updated.\n\n` +
        `**Example:** \`${example}\`\n\n` +
        `To fix **one** panel only, include **fix only panel named** and the full panel title.`
    );
}
