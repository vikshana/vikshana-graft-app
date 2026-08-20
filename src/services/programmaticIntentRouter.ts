import { parseGrafanaAlertCreateRequest, messageMentionsGrafanaAlertCreate } from './grafanaAlertParse';
import {
    messageMentionsPredictiveAnalyticsPanel,
    parseAddHistoryComparisonPanelRequest,
} from './historyComparisonPanelAddParse';
import {
    messageMentionsPeerBandPanelCreate,
    parseAddPeerBandPanelRequest,
} from './peerBandPanelAddParse';
import { messageDescribesPanelCreate, parsePanelCreateRequest } from './panelCreateParse';

/** Handlers that historically collided on operator wording. */
export type CollidingIntentId =
    | 'grafana-alert-create'
    | 'peer-band-create'
    | 'history-comparison'
    | 'panel-create';

export interface ScoredIntent {
    id: CollidingIntentId;
    score: number;
    reasons: string[];
}

export type IntentCollisionPair =
    | 'alert-vs-panel'
    | 'peer-band-vs-history-comparison'
    | 'sensing-voltage-vs-module-default';

/** Top-two scores within this margin → ask instead of guessing. */
const AMBIGUITY_MARGIN = 16;
/** Soft wins: primary below this with a colliding secondary also clarifies. */
const SOFT_WINNER_SCORE = 60;
const MIN_AMBIGUOUS_SCORE = 45;

const INTENT_LABELS: Record<CollidingIntentId, string> = {
    'grafana-alert-create': 'Grafana-managed alert (notify on panel condition)',
    'peer-band-create': 'Peer Band ±2σ panel (Flux peer mean / bounds)',
    'history-comparison': 'Random Forest History Comparison panel (Prometheus ML bands)',
    'panel-create': 'Generic panel create (bar chart / gauge / stat / table)',
};

const INTENT_EXAMPLES: Record<CollidingIntentId, string> = {
    'grafana-alert-create':
        'Create a Grafana-managed alert for the panel titled "Module 2 Pressure — Alert Test Peer Band ±2σ" on the dashboard with UID = grafte2ekeysht. Configure the alert to trigger when Module 1 Actual is outside the ±2σ bounds. Notify Alex Test Email.',
    'peer-band-create':
        'Create a new machine learning time series panel titled "Module 2 Pressure — Alert Test Peer Band ±2σ" on the dashboard with UID grafte2ekeysht. Compare Module 2 Pressure against the average of Modules 1 and 3 through 8. Calculate Upper/Lower Peer Bounds in the Flux query.',
    'history-comparison':
        'Create a Random Forest machine learning panel for sensing voltage on the dashboard with UID = grafte2ekeysht.',
    'panel-create':
        'Create a bar chart panel called "Cartridge Comparison" on dashboard UID = grafte2ekeysht.',
};

function normalize(text: string): string {
    return text.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
}

function pushReason(reasons: string[], reason: string, delta: number): number {
    reasons.push(`${reason} (${delta >= 0 ? '+' : ''}${delta})`);
    return delta;
}

export function scoreGrafanaAlertCreateIntent(
    message: string,
    contextDashboardUid?: string
): ScoredIntent | null {
    const text = normalize(message.trim());
    if (!messageMentionsGrafanaAlertCreate(text)) {
        return null;
    }
    const reasons: string[] = [];
    let score = 55;
    pushReason(reasons, 'mentions Grafana alert create', 55);

    if (parseGrafanaAlertCreateRequest(text, { contextDashboardUid })) {
        score += pushReason(reasons, 'parseGrafanaAlertCreateRequest', 35);
    }
    if (/\bgrafana[- ]?managed\s+alert\b/i.test(text)) {
        score += pushReason(reasons, 'Grafana-managed alert wording', 12);
    }
    if (/\bfor\s+(?:the\s+)?panel\s+titled\b/i.test(text)) {
        score += pushReason(reasons, 'alert for panel titled', 10);
    }
    if (/\b(notify|contact\s*point|trigger\s+when|reduce)\b/i.test(text)) {
        score += pushReason(reasons, 'alert configuration detail', 8);
    }
    if (/\b(create|add)\b[\s\S]{0,100}\bpanel\b/i.test(text) && !/\balert\b/i.test(text)) {
        score += pushReason(reasons, 'panel create without alert noun', -35);
    }
    return { id: 'grafana-alert-create', score, reasons };
}

export function scorePeerBandCreateIntent(message: string): ScoredIntent | null {
    const text = normalize(message.trim());
    if (!messageMentionsPeerBandPanelCreate(text)) {
        return null;
    }
    const reasons: string[] = [];
    let score = 50;
    pushReason(reasons, 'mentions peer-band panel create', 50);

    if (parseAddPeerBandPanelRequest(text)) {
        score += pushReason(reasons, 'parseAddPeerBandPanelRequest', 35);
    }
    if (/\bpeer\s+mean\b/i.test(text)) {
        score += pushReason(reasons, 'Peer Mean line', 15);
    }
    if (/\bupper\s+peer\s+bound\b/i.test(text)) {
        score += pushReason(reasons, 'Upper Peer Bound', 12);
    }
    if (/\blower\s+peer\s+bound\b/i.test(text)) {
        score += pushReason(reasons, 'Lower Peer Bound', 8);
    }
    if (/\bpeer\s*band\b/i.test(text)) {
        score += pushReason(reasons, 'Peer Band in text', 10);
    }
    if (/\baverage\s+of\s+modules?\b/i.test(text)) {
        score += pushReason(reasons, 'average of modules', 10);
    }
    if (/\bflux\b/i.test(text)) {
        score += pushReason(reasons, 'Flux query', 6);
    }
    if (/\bsensing\s+voltage\b/i.test(text)) {
        score += pushReason(reasons, 'sensing voltage (not peer-band)', -40);
    }
    if (/\brandom\s*forest\b/i.test(text) && !/\bpeer\b/i.test(text)) {
        score += pushReason(reasons, 'Random Forest without peer wording', -18);
    }
    return { id: 'peer-band-create', score, reasons };
}

export function scoreHistoryComparisonIntent(message: string): ScoredIntent | null {
    const text = normalize(message.trim());
    if (!messageMentionsPredictiveAnalyticsPanel(text)) {
        return null;
    }
    const reasons: string[] = [];
    let score = 48;
    pushReason(reasons, 'mentions predictive analytics / RF', 48);

    const parsed = parseAddHistoryComparisonPanelRequest(text);
    if (parsed) {
        score += pushReason(reasons, 'parseAddHistoryComparisonPanelRequest', 35);
    }
    if (/\bsensing\s+voltage\b/i.test(text)) {
        score += pushReason(reasons, 'sensing voltage signal', 28);
    }
    if (parsed?.signal?.field === 'Cartridge_Sensing_Voltage') {
        score += pushReason(reasons, 'resolved Cartridge_Sensing_Voltage', 18);
    }
    if (/\brandom\s*forest\b/i.test(text)) {
        score += pushReason(reasons, 'Random Forest', 8);
    }
    if (/\bpeer\s+mean\b/i.test(text)) {
        score += pushReason(reasons, 'Peer Mean (peer-band)', -28);
    }
    if (/\bupper\s+peer\s+bound\b/i.test(text)) {
        score += pushReason(reasons, 'Upper Peer Bound (peer-band)', -22);
    }
    if (/\baverage\s+of\s+modules?\b/i.test(text)) {
        score += pushReason(reasons, 'average of modules (peer-band)', -18);
    }
    if (/\bpressure\b/i.test(text) && /\bpeer\b/i.test(text)) {
        score += pushReason(reasons, 'pressure + peer (peer-band)', -12);
    }
    return { id: 'history-comparison', score, reasons };
}

export function scorePanelCreateIntent(message: string, contextDashboardUid?: string): ScoredIntent | null {
    const text = normalize(message.trim());
    if (!messageDescribesPanelCreate(text)) {
        return null;
    }
    const reasons: string[] = [];
    let score = 42;
    pushReason(reasons, 'generic panel create wording', 42);
    if (parsePanelCreateRequest(text, { contextDashboardUid })) {
        score += pushReason(reasons, 'parsePanelCreateRequest', 30);
    }
    if (/\b(bar\s*chart|gauge|stat|table)\b/i.test(text)) {
        score += pushReason(reasons, 'typed panel', 8);
    }
    return { id: 'panel-create', score, reasons };
}

function scoreForcedCollisionPair(message: string): ScoredIntent[] | null {
    const text = normalize(message.trim());
    if (
        !/\b(create|add|new|make)\b/i.test(text) ||
        !/\b(machine\s+learning|time\s+series\s+panel)\b/i.test(text)
    ) {
        return null;
    }
    const hasPeerMean = /\bpeer\s+mean\b/i.test(text);
    const hasRfPredictive =
        /\brandom\s*forest\b/i.test(text) && /\bpredictive\s+analytics\b/i.test(text);
    if (hasPeerMean && hasRfPredictive) {
        return [
            {
                id: 'peer-band-create',
                score: 66,
                reasons: ['collision: peer mean + panel create (+66)'],
            },
            {
                id: 'history-comparison',
                score: 64,
                reasons: ['collision: Random Forest predictive analytics + panel create (+64)'],
            },
        ];
    }
    return null;
}

/** Keyword signals when mention-gates exclude each other but operator wording overlaps. */
function scoreLatentIntentOverlays(message: string, primary: ScoredIntent[]): ScoredIntent[] {
    const text = normalize(message.trim());
    if (primary.some((p) => p.id === 'peer-band-create' && p.score >= 85)) {
        return [];
    }
    if (primary.some((p) => p.id === 'grafana-alert-create' && p.score >= 85)) {
        return [];
    }

    const createsMlPanel =
        /\b(create|add|new|make)\b/i.test(text) &&
        /\b(machine\s+learning|random\s*forest|predictive\s+analytics|time\s+series\s+panel)\b/i.test(text);
    if (!createsMlPanel) {
        return [];
    }

    const overlays: ScoredIntent[] = [];
    const peerBandWording =
        /\bpeer\s*band\b/i.test(text) ||
        /\bpeer\s+mean\b/i.test(text) ||
        /\bupper\s+peer\s+bound\b/i.test(text) ||
        /\baverage\s+of\s+modules?\b/i.test(text);

    if (!messageMentionsPeerBandPanelCreate(text)) {
        const reasons: string[] = [];
        let score = 38;
        pushReason(reasons, 'latent ML panel create', 38);
        if (/\bpeer\s+mean\b/i.test(text)) {
            score += pushReason(reasons, 'peer mean (latent)', 22);
        }
        if (/\bupper\s+peer\s+bound\b/i.test(text)) {
            score += pushReason(reasons, 'upper peer bound (latent)', 18);
        }
        if (/\baverage\s+of\s+modules?\b/i.test(text)) {
            score += pushReason(reasons, 'average of modules (latent)', 20);
        }
        if (/\bcompare\s+module\s*\d+\b/i.test(text) && /\bpressure\b/i.test(text)) {
            score += pushReason(reasons, 'compare module pressure (latent)', 16);
        }
        if (score >= MIN_AMBIGUOUS_SCORE) {
            overlays.push({ id: 'peer-band-create', score, reasons });
        }
    }

    if (!messageMentionsPredictiveAnalyticsPanel(text) && !peerBandWording) {
        const reasons: string[] = [];
        let score = 36;
        pushReason(reasons, 'latent ML panel create', 36);
        if (/\brandom\s*forest\b/i.test(text)) {
            score += pushReason(reasons, 'Random Forest (latent)', 22);
        }
        if (/\bpredictive\s+analytics\b/i.test(text)) {
            score += pushReason(reasons, 'predictive analytics (latent)', 20);
        }
        if (/\bsensing\s+voltage\b/i.test(text)) {
            score += pushReason(reasons, 'sensing voltage (latent)', 24);
        }
        if (/\bmodule\s*\d+\b/i.test(text) && /\bpressure\b/i.test(text)) {
            score += pushReason(reasons, 'module pressure RF (latent)', 14);
        }
        if (score >= MIN_AMBIGUOUS_SCORE) {
            overlays.push({ id: 'history-comparison', score, reasons });
        }
    }

    return overlays;
}

function mergeIntentScores(primary: ScoredIntent[], overlays: ScoredIntent[]): ScoredIntent[] {
    const byId = new Map<CollidingIntentId, ScoredIntent>();
    for (const item of [...primary, ...overlays]) {
        const existing = byId.get(item.id);
        if (!existing || item.score > existing.score) {
            byId.set(item.id, item);
        }
    }
    return [...byId.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

export function scoreIntentCandidates(
    message: string,
    contextDashboardUid?: string
): ScoredIntent[] {
    const forced = scoreForcedCollisionPair(message);
    if (forced) {
        return forced;
    }

    const primary = [
        scoreGrafanaAlertCreateIntent(message, contextDashboardUid),
        scorePeerBandCreateIntent(message),
        scoreHistoryComparisonIntent(message),
        scorePanelCreateIntent(message, contextDashboardUid),
    ].filter((c): c is ScoredIntent => c != null);

    return mergeIntentScores(primary, scoreLatentIntentOverlays(message, primary));
}

function collisionPair(a: CollidingIntentId, b: CollidingIntentId): IntentCollisionPair | null {
    const ids = new Set([a, b]);
    if (ids.has('grafana-alert-create') && ids.has('panel-create')) {
        return 'alert-vs-panel';
    }
    if (ids.has('peer-band-create') && ids.has('history-comparison')) {
        return 'peer-band-vs-history-comparison';
    }
    if (ids.has('history-comparison') && ids.has('peer-band-create')) {
        return 'peer-band-vs-history-comparison';
    }
    return null;
}

export function detectIntentAmbiguity(candidates: ScoredIntent[]): {
    primary: ScoredIntent;
    secondary: ScoredIntent;
    pair: IntentCollisionPair;
} | null {
    if (candidates.length < 2) {
        return null;
    }
    const [primary, secondary] = candidates;
    if (primary.score < MIN_AMBIGUOUS_SCORE || secondary.score < MIN_AMBIGUOUS_SCORE) {
        return null;
    }
    const pair = collisionPair(primary.id, secondary.id);
    if (!pair) {
        return null;
    }
    const margin = primary.score - secondary.score;
    const closeRace = margin <= AMBIGUITY_MARGIN;
    const softWinner = primary.score < SOFT_WINNER_SCORE && margin <= AMBIGUITY_MARGIN + 8;
    if (!closeRace && !softWinner) {
        return null;
    }
    return { primary, secondary, pair };
}

/** Ops / tests: winner score when routing proceeds without clarification. */
export function intentRouteWinnerScore(
    message: string,
    contextDashboardUid?: string
): number | null {
    const candidates = scoreIntentCandidates(message, contextDashboardUid);
    if (candidates.length === 0 || detectIntentAmbiguity(candidates)) {
        return null;
    }
    return candidates[0].score;
}

export function formatIntentDisambiguationReply(
    ambiguity: NonNullable<ReturnType<typeof detectIntentAmbiguity>>,
    buildNumber: number
): string {
    const { primary, secondary } = ambiguity;
    return (
        `### Need clarification — which action? (Graft build ${buildNumber})\n\n` +
        `Your prompt scored closely on two programmatic paths:\n` +
        `- **${INTENT_LABELS[primary.id]}** (routing score **${primary.score}**)\n` +
        `- **${INTENT_LABELS[secondary.id]}** (routing score **${secondary.score}**)\n\n` +
        `**Did you mean one of these?** Reply with the full example that matches your goal:\n\n` +
        `1. ${INTENT_EXAMPLES[primary.id]}\n\n` +
        `2. ${INTENT_EXAMPLES[secondary.id]}\n\n` +
        `_Graft will not guess when routing confidence is tied — picking the wrong handler can save the wrong panel or alert._`
    );
}

/**
 * When an independently observed panel title (e.g. post-save dashboard re-fetch on the LLM path)
 * does not match what the operator prompt resolved to, return a corrective clarification.
 * Not for programmatic HC saves — those use the same parsed signal as addResult.panelTitle.
 */
export function formatHistoryComparisonOutcomeMismatch(
    userMessage: string,
    panelTitle: string | undefined,
    buildNumber: number
): string | null {
    if (!panelTitle?.trim()) {
        return null;
    }
    const text = normalize(userMessage);
    const saved = panelTitle.trim();
    const savedLc = saved.toLowerCase();

    const hcReq = parseAddHistoryComparisonPanelRequest(text);
    if (hcReq?.signal?.panelTitle) {
        const expected = hcReq.signal.panelTitle.trim();
        if (expected.toLowerCase() !== savedLc) {
            const askedLabel = hcReq.metricLabel ?? hcReq.signal.titleBase ?? expected;
            if (/\bsensing\s+voltage\b/i.test(askedLabel)) {
                return (
                    `### Routing mismatch — did you mean Sensing Voltage? (Graft build ${buildNumber})\n\n` +
                    `You asked for **sensing voltage**, but the saved panel is **${saved}**.\n\n` +
                    `**Try instead:**\n` +
                    `> ${INTENT_EXAMPLES['history-comparison']}\n\n` +
                    `_For Pressure peer-mean bands, use a **Peer Band** panel instead of History Comparison._`
                );
            }
            return (
                `### Routing mismatch — panel title does not match request (Graft build ${buildNumber})\n\n` +
                `You asked for **${askedLabel}**, but the saved panel is **${saved}**.\n\n` +
                `**Try again with an explicit signal:**\n` +
                `> ${INTENT_EXAMPLES['history-comparison']}`
            );
        }
    }

    const peerReq = parseAddPeerBandPanelRequest(text);
    if (peerReq && savedLc.includes('history comparison')) {
        return (
            `### Routing mismatch — did you mean Peer Band? (Graft build ${buildNumber})\n\n` +
            `Your prompt describes **peer mean / peer bounds**, but Graft saved **${saved}** (History Comparison).\n\n` +
            `**Try instead:**\n` +
            `> ${INTENT_EXAMPLES['peer-band-create']}`
        );
    }

    const alertReq = parseGrafanaAlertCreateRequest(text);
    if (
        alertReq &&
        savedLc.includes('peer band') &&
        !savedLc.includes('alert')
    ) {
        return (
            `### Routing mismatch — did you mean Grafana alert create? (Graft build ${buildNumber})\n\n` +
            `You asked to **create an alert**, but Graft added or updated panel **${saved}** instead.\n\n` +
            `**Try instead:**\n` +
            `> ${INTENT_EXAMPLES['grafana-alert-create']}`
        );
    }

    return null;
}

/** True when colliding intents are too close to pick safely (clarify instead of mutate). */
export function messageNeedsIntentRouteClarification(
    message: string,
    contextDashboardUid?: string
): boolean {
    return detectIntentAmbiguity(scoreIntentCandidates(message, contextDashboardUid)) != null;
}

/** Returns a disambiguation reply when top intent scores are tied; otherwise null (proceed). */
export function resolveIntentRouteAmbiguity(
    message: string,
    buildNumber: number,
    contextDashboardUid?: string
): string | null {
    const candidates = scoreIntentCandidates(message, contextDashboardUid);
    const ambiguity = detectIntentAmbiguity(candidates);
    if (!ambiguity) {
        return null;
    }
    return formatIntentDisambiguationReply(ambiguity, buildNumber);
}

/** Prefer the winning handler when scores are not ambiguous (for logging/tests). */
export function preferredIntentHandler(
    message: string,
    contextDashboardUid?: string
): CollidingIntentId | null {
    const candidates = scoreIntentCandidates(message, contextDashboardUid);
    if (candidates.length === 0 || detectIntentAmbiguity(candidates)) {
        return null;
    }
    return candidates[0].id;
}

/** One-line footer when a colliding-intent winner is soft but still unambiguous enough to proceed. */
export function formatSoftIntentConfidenceNote(score: number): string {
    return (
        `\n\n_Routing confidence: **${score}** — reply if this looks wrong ` +
        '(Graft picked the clearer of two close programmatic paths)._'
    );
}
