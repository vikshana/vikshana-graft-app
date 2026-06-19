import { extractAllDashboardUids } from './dashboardMentionParse';

import {

    extractSourceMachineId,

    extractTargetMachineId,

    findMachineIdsInText,

    isMachineId,

} from './dashboardCloneParse';

import { PEER_BAND_TITLE_MARKER } from './fluxPeerBandFix';

import { BULK_PEER_BAND_DEFAULT_TITLE_FILTER } from './peerBandShared';



/** After "uid" in dashboard phrases — supports uid=abc and uid "abc". */

const UID_VALUE = String.raw`uid\s*[=:#]?\s*["']?([a-zA-Z0-9]{6,})["']?`;



export interface PeerBandPanelCopyRequest {

    sourceDashboardUid: string;

    targetDashboardUids: string[];

    titleContains: string;

    sourceMachineId?: string;

    /** When set, applied to every target unless overridden per uid. */

    targetMachineId?: string;

    /** Per-target machine id (uid → machine). */

    targetMachineByUid?: Record<string, string>;

    /** Replace panels on the target when the title already matches. */

    replaceExisting: boolean;

    /** User asked to verify peer-band panels on the target after save. */

    verifyAfterSave: boolean;

}



function normalizeMessageQuotes(text: string): string {

    return text.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");

}



export function messageDescribesPeerBandPanels(text: string): boolean {

    return (

        /\bpeer\s*band\b/i.test(text) ||

        /\bvs\.?\s*peer\b/i.test(text) ||

        /Peer Band \(Modules/i.test(text) ||

        (/\btitle\s+contains\b/i.test(text) && /\b(peer|band)\b/i.test(text))

    );

}



export function messageDescribesCrossDashboardPanelCopy(text: string): boolean {

    if (!/\b(copy|transplant|transfer)\b/i.test(text) || !/\bpanel/i.test(text)) {

        return false;

    }

    if (!/\bfrom\b/i.test(text)) {

        return false;

    }

    if (/\bto\b[^.\n]{0,80}?\buid\b/i.test(text) || /\binto\b[^.\n]{0,80}?\buid\b/i.test(text)) {

        return true;

    }

    // A source-only "copy … from … uid" still counts as (incomplete) cross-dashboard
    // copy intent so clarification can report the missing target uid. The full parse
    // still returns null without a target, so routing is unaffected.

    if (/\bfrom\b[^.\n]{0,80}?\buid\b/i.test(text)) {

        return true;

    }

    return extractAllDashboardUids(text).length >= 2;

}



/** User mentioned copy intent but message is missing required fields. */

export function messageMentionsPeerBandPanelCopyIntent(message: string): boolean {

    const text = normalizeMessageQuotes(message.trim());

    if (!text) {

        return false;

    }

    return messageDescribesPeerBandPanels(text) && messageDescribesCrossDashboardPanelCopy(text);

}



function extractTitleFilterFromMessage(text: string): string | undefined {

    const patterns = [

        /title\s+(?:contains|includes|matching|with)\s+"([^"]+)"/i,

        /(?:panels?\s+(?:whose\s+title\s+)?(?:contains|includes|with)|with)\s+"([^"]+)"\s+in\s+(?:the\s+)?title/i,

        /"([^"]+)"\s+in\s+(?:the\s+)?title/i,

    ];

    for (const re of patterns) {

        const match = text.match(re);

        if (match?.[1]?.trim()) {

            return match[1].trim();

        }

    }

    return undefined;

}



function extractRemapTargetMachineId(text: string): string | undefined {

    const patterns = [

        /\bremap\b[^.\n]{0,200}?\b(?:to\s+)?machine\s+([0-9]{4}-[0-9]+)/i,

        /\bremap\b[^.\n]{0,200}?\b(?:to\s+)?([0-9]{4}-[0-9]+)/i,

        /\buse\s+machine\s+([0-9]{4}-[0-9]+)/i,

        /\bfor\s+machine\s+([0-9]{4}-[0-9]+)/i,

    ];

    for (const re of patterns) {

        const m = text.match(re);

        if (m?.[1] && isMachineId(m[1])) {

            return m[1];

        }

    }

    return undefined;

}



export function messageWantsPostCopyVerification(text: string): boolean {

    return (

        /\b(verify|verification|confirm|check)\b/i.test(text) &&

        (messageDescribesPeerBandPanels(text) ||

            /\b(properly|working|results|afterwards|afterward)\b/i.test(text))

    );

}



export function extractSourceDashboardUid(message: string): string | undefined {

    const text = normalizeMessageQuotes(message.trim());

    const patterns = [

        new RegExp(`\\bfrom\\s+(?:the\\s+)?dashboard\\s+${UID_VALUE}`, 'i'),

        new RegExp(`\\bcopy\\s+(?:all\\s+)?panels?[^.\\n]{0,160}\\bfrom\\s+(?:dashboard\\s+)?${UID_VALUE}`, 'i'),

        new RegExp(`\\bsource\\s+(?:dashboard\\s+)?${UID_VALUE}`, 'i'),

    ];

    for (const re of patterns) {

        const m = text.match(re);

        if (m?.[1]) {

            return m[1];

        }

    }

    const all = extractAllDashboardUids(text);

    if (/\bto\b[^.\n]{0,80}?\buid\b/i.test(text) && all.length >= 2) {

        return all[0];

    }

    if (/\bfrom\b/i.test(text) && all.length >= 1) {

        return all[0];

    }

    return undefined;

}



export function extractTargetDashboardUids(message: string, sourceUid?: string): string[] {

    const text = normalizeMessageQuotes(message.trim());

    const targets: string[] = [];

    const toPattern = new RegExp(`\\bto\\s+(?:dashboard\\s+)?${UID_VALUE}`, 'gi');

    for (const m of text.matchAll(toPattern)) {

        if (m[1] && m[1] !== sourceUid) {

            targets.push(m[1]);

        }

    }

    const intoPattern = new RegExp(`\\binto\\s+(?:dashboard\\s+)?${UID_VALUE}`, 'gi');

    for (const m of text.matchAll(intoPattern)) {

        if (m[1] && m[1] !== sourceUid) {

            targets.push(m[1]);

        }

    }

    const all = extractAllDashboardUids(text).filter((id) => id !== sourceUid);

    return [...new Set([...targets, ...all])];

}



/** What is missing from a copy request (for clarification). Empty if parse would succeed. */

export function diagnosePeerBandPanelCopyGaps(message: string): string[] {

    const text = normalizeMessageQuotes(message.trim());

    const gaps: string[] = [];

    if (!messageMentionsPeerBandPanelCopyIntent(text)) {

        return gaps;

    }

    if (!extractSourceDashboardUid(text)) {

        gaps.push('**Source dashboard uid** (e.g. `from dashboard uid="6gawrgawrgragg"`)');

    }

    const source = extractSourceDashboardUid(text);

    if (extractTargetDashboardUids(text, source).length === 0) {

        gaps.push('**Target dashboard uid** (e.g. `to dashboard uid="bfo0v59rxtou8e"`)');

    }

    const remap = extractRemapTargetMachineId(text);

    const dataFor = extractTargetMachineId(text);

    const machineIds = findMachineIdsInText(text);

    if (!remap && !dataFor && machineIds.length === 0) {

        gaps.push(

            '**Target machine id** (e.g. `Remap to machine 2505-200033`) — optional if the target dashboard title already includes it'

        );

    }

    return gaps;

}



/** Plain-English prompt operators can paste into Graft (replace uids / machines as needed). */

export function formatPeerBandPanelCopyExamplePrompt(

    sourceUid = 'SOURCE_UID',

    targetUids: string[] = ['TARGET_UID_1']

): string {

    const targetPart = targetUids.map((u) => `uid="${u}"`).join(', ');

    return (

        `Copy all panels whose title contains "${BULK_PEER_BAND_DEFAULT_TITLE_FILTER}" ` +

        `from dashboard uid="${sourceUid}" to dashboard ${targetPart}. ` +

        `Remap those panels to machine 2505-200033. ` +

        `Verify afterwards that all vs. Peer Band panels on the target dashboard are working.`

    );

}



export const PEER_BAND_PANEL_COPY_EXAMPLE_PROMPT = formatPeerBandPanelCopyExamplePrompt();



export function parsePeerBandPanelCopyRequest(message: string): PeerBandPanelCopyRequest | null {

    const text = normalizeMessageQuotes(message.trim());

    if (!text) {

        return null;

    }



    if (!messageMentionsPeerBandPanelCopyIntent(text)) {

        return null;

    }



    const sourceDashboardUid = extractSourceDashboardUid(text);

    if (!sourceDashboardUid) {

        return null;

    }



    const targetDashboardUids = extractTargetDashboardUids(text, sourceDashboardUid).filter(

        (uid) => uid !== sourceDashboardUid

    );

    if (targetDashboardUids.length === 0) {

        return null;

    }



    const titleContains =

        extractTitleFilterFromMessage(text) ??

        (/\bvs\.?\s*peer\b/i.test(text) ? BULK_PEER_BAND_DEFAULT_TITLE_FILTER : PEER_BAND_TITLE_MARKER);



    const sourceMachineId = extractSourceMachineId(text);

    const targetMachineId =

        extractRemapTargetMachineId(text) ??

        extractTargetMachineId(text) ??

        (findMachineIdsInText(text).length === 1 ? findMachineIdsInText(text)[0] : undefined);



    const targetMachineByUid: Record<string, string> = {};

    for (const uid of targetDashboardUids) {

        const perTarget = text.match(

            new RegExp(

                `\\b(?:to|into)\\s+(?:dashboard\\s+)?uid\\s*[=:#]?\\s*["']?${uid}["']?[^.\\n]{0,120}?([0-9]{4}-[0-9]+)`,

                'i'

            )

        );

        if (perTarget?.[1] && isMachineId(perTarget[1])) {

            targetMachineByUid[uid] = perTarget[1];

        }

    }



    const replaceExisting = !/\bappend\s+only\b/i.test(text) && !/\bdo not replace\b/i.test(text);

    const verifyAfterSave = messageWantsPostCopyVerification(text);



    return {

        sourceDashboardUid,

        targetDashboardUids,

        titleContains,

        sourceMachineId,

        targetMachineId: targetMachineId && isMachineId(targetMachineId) ? targetMachineId : undefined,

        targetMachineByUid: Object.keys(targetMachineByUid).length > 0 ? targetMachineByUid : undefined,

        replaceExisting,

        verifyAfterSave,

    };

}



export function userWantsPeerBandPanelCopy(message: string): boolean {

    return parsePeerBandPanelCopyRequest(message) != null;

}



export function formatPeerBandPanelCopyClarification(message?: string): string {

    const gaps = message ? diagnosePeerBandPanelCopyGaps(message) : [];

    const gapBlock =

        gaps.length > 0

            ? `\n\nGraft still needs:\n${gaps.map((g) => `- ${g}`).join('\n')}\n`

            : '\n\nInclude **source** and **target** dashboard uids and, if needed, the **target machine id**.\n';



    return (

        `### Need clarification\n\n` +

        `To copy **vs. Peer Band** panels from one dashboard into another, say which dashboards and how to remap machine ids.${gapBlock}` +

        `**Example:** \`${formatPeerBandPanelCopyExamplePrompt('6gawrgawrgragg', ['bfo0v59rxtou8e'])}\``

    );

}


