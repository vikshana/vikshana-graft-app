import { extractDashboardUidFromMessage, mentionsDashboard } from './dashboardMentionParse';
import { messageMentionsGrafanaAlertCreate, messageMentionsGrafanaAlertUpdate } from './grafanaAlertParse';

export interface DashboardReviewRequest {
    dashboardUid: string;
    suggestionCount: number;
}

const WORD_NUMBERS: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
};

function normalizeMessageQuotes(text: string): string {
    return text.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
}

/** User asked to apply or implement review suggestions — not suggestions-only. */
export function userWantsDashboardReviewApply(message: string): boolean {
    const text = normalizeMessageQuotes(message.trim());
    return /\b(apply|implement|make\s+(these|the)\s+changes|go\s+ahead|do\s+it|please\s+fix|update\s+the\s+dashboard)\b/i.test(
        text
    );
}

/** Review / suggest / readability audit without an explicit apply step. */
export function userWantsDashboardReviewOnly(message: string): boolean {
    const text = normalizeMessageQuotes(message.trim());
    if (!text || userWantsDashboardReviewApply(text)) {
        return false;
    }
    if (messageMentionsGrafanaAlertCreate(text) || messageMentionsGrafanaAlertUpdate(text)) {
        return false;
    }

    // Do not treat alert "evaluate every minute" as a dashboard review/audit.
    const reviewVerb =
        /\b(review|analyze|analyse|audit|assess|inspect)\b/i.test(text) ||
        (/\bevaluate\b/i.test(text) && !/\bevaluate\s+every\b/i.test(text));
    const suggestVerb =
        /\b(suggest|recommend|propose|ideas?)\b/i.test(text) &&
        /\b(improvement|readability|layout|organiz|organis|hierarchy|clean\s*up)\b/i.test(text);
    if (!reviewVerb && !suggestVerb) {
        return false;
    }

    return Boolean(extractDashboardUidFromMessage(text) || mentionsDashboard(text));
}

function extractSuggestionCount(text: string): number {
    const wordMatch = text.match(
        /\b(one|two|three|four|five|six|seven|eight|nine|ten|\d{1,2})\s+improvements?\b/i
    );
    if (wordMatch?.[1]) {
        const raw = wordMatch[1].toLowerCase();
        const fromWord = WORD_NUMBERS[raw];
        if (fromWord) {
            return fromWord;
        }
        const n = parseInt(raw, 10);
        if (Number.isFinite(n) && n > 0) {
            return Math.min(n, 10);
        }
    }

    const suggestN = text.match(/\bsuggest\s+(\d{1,2})\b/i);
    if (suggestN?.[1]) {
        const n = parseInt(suggestN[1], 10);
        if (Number.isFinite(n) && n > 0) {
            return Math.min(n, 10);
        }
    }

    return 3;
}

export function parseDashboardReviewRequest(message: string): DashboardReviewRequest | null {
    const text = normalizeMessageQuotes(message.trim());
    if (!userWantsDashboardReviewOnly(text)) {
        return null;
    }

    const dashboardUid = extractDashboardUidFromMessage(text);
    if (!dashboardUid) {
        return null;
    }

    return {
        dashboardUid,
        suggestionCount: extractSuggestionCount(text),
    };
}

export interface DashboardImproveRequest {
    dashboardUid: string;
}

/**
 * User asked Graft to review/improve a dashboard AND apply the changes (e.g. "suggest
 * improvements and apply …"). Distinct from review-only, and from clone/rename/panel ops
 * (which are matched earlier and don't carry a review/improve verb).
 */
export function userWantsDashboardImproveApply(message: string): boolean {
    const text = normalizeMessageQuotes(message.trim());
    if (!userWantsDashboardReviewApply(text)) {
        return false;
    }
    const improveVerb =
        /\b(improve|improvement|readability|review|audit|optimi[sz]e|clean\s*up|tidy|reorganiz|reorganis)\b/i.test(
            text
        ) ||
        (/\b(suggest|recommend|propose)\b/i.test(text) && /\b(change|improvement|fix)/i.test(text));
    if (!improveVerb) {
        return false;
    }
    return Boolean(extractDashboardUidFromMessage(text));
}

export function parseDashboardImproveRequest(message: string): DashboardImproveRequest | null {
    const text = normalizeMessageQuotes(message.trim());
    if (!userWantsDashboardImproveApply(text)) {
        return null;
    }
    const dashboardUid = extractDashboardUidFromMessage(text);
    if (!dashboardUid) {
        return null;
    }
    return { dashboardUid };
}

export const DASHBOARD_REVIEW_EXAMPLE_PROMPT =
    'Review dashboard with UID = cfo0wckufbdhce and suggest three improvements to improve readability.';
