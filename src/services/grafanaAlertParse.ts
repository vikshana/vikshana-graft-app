import { extractAllDashboardUids, extractDashboardUidFromMessage } from './dashboardMentionParse';

export interface GrafanaAlertCreateRequest {
    dashboardUid?: string;
    panelTitle?: string;
    contactPoint?: string;
    /** Email address for an email contact point Graft should create if missing. */
    contactPointEmail?: string;
    /** True when the prompt asks Graft to create/add a (new) contact point. */
    createContactPoint?: boolean;
    /** Explicit alert rule title, e.g. "GraftAI Rule". */
    ruleTitle?: string;
    /** Alert folder title to store the rule in (created if missing). */
    folderTitle?: string;
    /** Evaluation / rule group name, e.g. "GraftAI Alert Groups". */
    ruleGroup?: string;
    /** Evaluation interval, e.g. "1m" / "5m". */
    every?: string;
    /** Pending duration before firing, e.g. "1m". */
    pendingFor?: string;
    /** Extra labels merged onto the rule (in addition to graft defaults). */
    labels?: Record<string, string>;
    /** When true, emit only explicitly requested labels/annotations (no graft defaults). */
    restrictMetadata?: boolean;
    /** Alert summary annotation. */
    summary?: string;
    /** Alert description annotation. */
    description?: string;
    /** Extra custom annotations (keys other than summary/description). */
    customAnnotations?: Record<string, string>;
    /**
     * Hybrid follow-up: operator said "Update" but asked to build/assign a *new* rule
     * for a named panel + dashboard — must use the create-from-panel path, not metadata update.
     */
    buildFromPanel?: boolean;
    /** Human description of the breach condition. */
    conditionSummary: string;
    /** True when the operator asked to alert from RandomForest vs Peers model output. */
    peerRfAlert?: boolean;
}

function normalizeMessageQuotes(text: string): string {
    return text.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
}

export function messageLooksLikePeerRfAlert(text: string): boolean {
    const blob = text.toLowerCase();
    const mentionsRf =
        /\brandom\s*forest\b/.test(blob) || /\brandomforest\b/.test(blob) || /\bpeer[- ]?rf\b/.test(blob);
    const mentionsPeers =
        /\bvs\s*\.?\s*peers?\b/.test(blob) ||
        /\bpeer\s+modules?\b/.test(blob) ||
        /\bpeer[- ]?rf\b/.test(blob);
    return mentionsRf && mentionsPeers;
}

/** True when the user is asking to create/configure a Grafana alert or alert rule. */
export function messageMentionsGrafanaAlertCreate(message: string): boolean {
    const text = normalizeMessageQuotes(message.trim());
    if (!text) {
        return false;
    }
    // Hybrid: "Update … for the panel … assign the new rule" → create-from-panel.
    if (messageWantsAlertRuleBuiltFromPanel(text)) {
        return true;
    }
    if (!/\b(create|add|set\s*up|configure|make|build|write)\b/i.test(text)) {
        return false;
    }
    if (/\balert\s+rule\b/i.test(text)) {
        return true;
    }
    if (/\bgrafana[- ]?managed\s+alert\b/i.test(text)) {
        return true;
    }
    if (/\bgrafana\s+alert\b/i.test(text)) {
        return true;
    }
    // "Create an alert for the panel titled …"
    if (/\balert\b/i.test(text) && /\bfor\s+(?:the\s+)?panel\b/i.test(text)) {
        return true;
    }
    // Alert + notify / contact point / trigger threshold
    return (
        /\balert\b/i.test(text) &&
        /\b(notify|notifications?|contact\s*point|trigger\s+when|threshold)\b/i.test(text)
    );
}

/**
 * Operator wants a *new* panel-backed alert rule (queries built from the panel),
 * even if the prompt starts with "Update the alert rule named …".
 * Signal: dashboard + panel + "new rule" / "assign the new rule".
 */
export function messageWantsAlertRuleBuiltFromPanel(message: string): boolean {
    const text = normalizeMessageQuotes(message.trim());
    if (!text) {
        return false;
    }
    const hasDashboard =
        extractAllDashboardUids(text).length > 0 ||
        Boolean(extractDashboardUidFromMessage(text)) ||
        /\bdashboard\s+with\s+uid\b/i.test(text);
    const hasPanel =
        Boolean(extractQuotedPanelTitle(text)) ||
        /\bpanel\s+(?:titled|of)\b/i.test(text) ||
        /\bfor\s+(?:the\s+)?panel\b/i.test(text);
    if (!hasDashboard || !hasPanel) {
        return false;
    }
    return (
        /\bassign\s+the\s+new\s+rule\b/i.test(text) ||
        /\b(?:create|make|build)\s+(?:a\s+)?new\s+(?:alert\s+)?rule\b/i.test(text) ||
        (/\bnew\s+rule\b/i.test(text) &&
            /\b(evaluation\s+group|rule\s+group|assign)\b/i.test(text))
    );
}

function extractQuotedPanelTitle(text: string): string | undefined {
    const patterns = [
        /\bpanel\s+titled\s+"([^"]+)"/i,
        /\bpanel\s+titled\s+'([^']+)'/i,
        /\bpanel\s+(?:named|called)\s+"([^"]+)"/i,
        /\bpanel\s+(?:named|called)\s+'([^']+)'/i,
        // "for the panel of "…" / "panel of "…"" (common in update follow-ups)
        /\b(?:for\s+(?:the\s+)?)?panel\s+of\s+"([^"]+)"/i,
        /\b(?:for\s+(?:the\s+)?)?panel\s+of\s+'([^']+)'/i,
        /\bfor\s+(?:the\s+)?panel\s+"([^"]+)"/i,
        /\bfor\s+(?:the\s+)?panel\s+'([^']+)'/i,
        // "on the panel "…""
        /\bon\s+(?:the\s+)?panel\s+"([^"]+)"/i,
        /\bon\s+(?:the\s+)?panel\s+'([^']+)'/i,
        // Unquoted: "panel titled Module 2 Pressure — … on the dashboard …"
        /\bpanel\s+titled\s+(.+?)\s+on\s+(?:the\s+)?dashboard\b/i,
        /\bpanel\s+(?:named|called)\s+(.+?)\s+on\s+(?:the\s+)?dashboard\b/i,
    ];
    for (const re of patterns) {
        const m = text.match(re);
        if (m?.[1]?.trim()) {
            return m[1].trim().replace(/[.,;:]+$/, '');
        }
    }
    return undefined;
}

function stripContactName(raw: string): string {
    return raw
        .trim()
        .replace(/^["']|["']$/g, '')
        .replace(/[.,;:]+$/, '')
        .trim();
}

function extractContactPoint(text: string): string | undefined {
    // "Set/assign the contact point as/to Alex Test Email"
    const setAs =
        text.match(
            /\b(?:set|assign|use|configure)\s+(?:the\s+)?contact\s*point\s+(?:as|to)\s+"([^"]+)"/i
        ) ??
        text.match(
            /\b(?:set|assign|use|configure)\s+(?:the\s+)?contact\s*point\s+(?:as|to)\s+'([^']+)'/i
        ) ??
        text.match(
            /\b(?:set|assign|use|configure)\s+(?:the\s+)?contact\s*point\s+(?:as|to)\s+([A-Za-z0-9][A-Za-z0-9 ._-]*?)(?=\s+for\b|\s+on\b|\s+to\b|[.,;\n]|$)/i
        );
    if (setAs?.[1]?.trim()) {
        return stripContactName(setAs[1]);
    }
    // "contact point named/called X" (also covers create phrasing).
    const namedContact = text.match(
        /\bcontact\s*point\s+(?:named|called)\s+"([^"]+)"/i
    ) ?? text.match(/\bcontact\s*point\s+(?:named|called)\s+([A-Za-z0-9 ._-]+?)(?=\s+(?:using|with|and|that|to)\b|[.,;:\n]|$)/i);
    if (namedContact?.[1]?.trim()) {
        return stripContactName(namedContact[1]);
    }
    // "named/called X ... contact point" (name precedes the noun).
    const createNamed = text.match(
        /\b(?:named|called)\s+([A-Za-z0-9 ._-]+?)\s+(?:using|with)\b[^\n]*?\bcontact\s*point\b/i
    );
    if (createNamed?.[1]?.trim()) {
        return stripContactName(createNamed[1]);
    }
    const named = text.match(
        /\b(?:notify|notifications?\s+to)\s+(?:the\s+)?(.+?)\s+contact\s*point\b/i
    );
    if (named?.[1]?.trim()) {
        return stripContactName(named[1]);
    }
    // "Configure the rule to notify the Alex Test Email contact point"
    const notifyCp = text.match(
        /\bnotify\s+(?:the\s+)?([A-Za-z0-9][A-Za-z0-9 ._-]*?)\s+contact\s*point\b/i
    );
    if (notifyCp?.[1]?.trim()) {
        return stripContactName(notifyCp[1]);
    }
    const sendTo = text.match(/\bSend\s+notifications\s+to\s+([^.!\n]+)/i);
    if (sendTo?.[1]?.trim()) {
        return stripContactName(sendTo[1]);
    }
    const quoted = text.match(/\bcontact\s*point\s+["']([^"']+)["']/i);
    if (quoted?.[1]?.trim()) {
        return quoted[1].trim();
    }
    return undefined;
}

function extractContactPointEmail(text: string): string | undefined {
    const m = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    return m?.[0];
}

function messageWantsNewContactPoint(text: string): boolean {
    return /\b(create|add|make|set\s*up)\b[^.\n]*\b(new\s+)?(email\s+)?contact\s*point\b/i.test(text);
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
    fifteen: 15,
    thirty: 30,
};

/** Convert "5 minutes" / "five minutes" / "1m" → Grafana duration like "5m". */
function toGrafanaDuration(amountRaw: string, unitRaw: string): string | undefined {
    const amountLower = amountRaw.trim().toLowerCase();
    const n = /^\d+$/.test(amountLower) ? Number(amountLower) : WORD_NUMBERS[amountLower];
    if (n == null || !Number.isFinite(n) || n <= 0) {
        return undefined;
    }
    const u = unitRaw.trim().toLowerCase();
    if (/^s(ec(ond)?s?)?$/.test(u)) {
        return `${n}s`;
    }
    if (/^m(in(ute)?s?)?$/.test(u)) {
        return `${n}m`;
    }
    if (/^h(our)?s?$/.test(u)) {
        return `${n}h`;
    }
    if (/^d(ay)?s?$/.test(u)) {
        return `${n}d`;
    }
    return undefined;
}

function extractRuleTitle(text: string): string | undefined {
    // Prefer "alert/alarm named|titled X" before contact-point "named".
    // Operators often say "alarm" for Grafana-managed alert rules.
    const patterns = [
        /\b(?:grafana[- ]?managed\s+)?(?:alert|alarm)(?:\s+rule)?\s+(?:named|titled|called)\s+"([^"]+)"/i,
        /\b(?:grafana[- ]?managed\s+)?(?:alert|alarm)(?:\s+rule)?\s+(?:named|titled|called)\s+'([^']+)'/i,
        /\b(?:grafana[- ]?managed\s+)?(?:alert|alarm)(?:\s+rule)?\s+(?:named|titled|called)\s+([A-Za-z0-9][A-Za-z0-9 ._-]*?)(?=\s+for\s+(?:the\s+)?panel\b|\s+on\s+the\s+dashboard\b|[.,;\n]|$)/i,
        /\balert\s+rule\s+(?:titled|called)\s+"([^"]+)"/i,
        /\balert\s+rule\s+(?:titled|called)\s+'([^']+)'/i,
        // "for the GraftAI Rule on the panel …"
        /\bfor\s+(?:the\s+)?([A-Za-z0-9][A-Za-z0-9 ._-]*?)\s+on\s+(?:the\s+)?panel\b/i,
        // "the GraftAI Rule on the panel …" / "GraftAI Rule on the panel"
        /\b(?:the\s+)?([A-Za-z0-9][A-Za-z0-9 ._-]*?\s+Rule)\s+on\s+(?:the\s+)?panel\b/i,
    ];
    for (const re of patterns) {
        const m = text.match(re);
        if (m?.[1]?.trim()) {
            const title = m[1].trim().replace(/[.,;:]+$/, '');
            // Avoid capturing "contact point as Alex Test Email for the GraftAI Rule"
            if (/^contact\s*point\b/i.test(title) || /^panel\b/i.test(title)) {
                continue;
            }
            return title;
        }
    }
    return undefined;
}

function extractFolderTitle(text: string): string | undefined {
    const patterns = [
        /\b(?:new\s+)?folder\s+called\s+"([^"]+)"/i,
        /\b(?:new\s+)?folder\s+called\s+'([^']+)'/i,
        /\b(?:new\s+)?folder\s+called\s+([A-Za-z0-9][A-Za-z0-9 ._-]*?)(?=[.,;\n]|$)/i,
        /\b(?:new\s+)?folder\s+named\s+"([^"]+)"/i,
        /\b(?:new\s+)?folder\s+named\s+'([^']+)'/i,
        /\bstore\s+(?:the\s+)?rule\s+in\s+(?:a\s+)?(?:new\s+)?folder\s+(?:called|named)\s+"([^"]+)"/i,
        /\bstore\s+(?:the\s+)?rule\s+in\s+(?:a\s+)?(?:new\s+)?folder\s+(?:called|named)\s+([A-Za-z0-9][A-Za-z0-9 ._-]*?)(?=[.,;\n]|$)/i,
    ];
    for (const re of patterns) {
        const m = text.match(re);
        if (m?.[1]?.trim()) {
            return m[1].trim().replace(/[.,;:]+$/, '');
        }
    }
    return undefined;
}

function extractRuleGroup(text: string): string | undefined {
    const patterns = [
        /\bevaluation\s+group\s+(?:named|called)\s+"([^"]+)"/i,
        /\bevaluation\s+group\s+(?:named|called)\s+'([^']+)'/i,
        /\bevaluation\s+group\s+(?:named|called)\s+([A-Za-z0-9][A-Za-z0-9 ._-]*?)(?=\s+that\b|\s+evaluat|\s+with\b|[.,;\n]|$)/i,
        /\brule\s+group\s+(?:named|called)\s+"([^"]+)"/i,
        /\brule\s+group\s+(?:named|called)\s+([A-Za-z0-9][A-Za-z0-9 ._-]*?)(?=\s+that\b|\s+evaluat|[.,;\n]|$)/i,
        // "Change the Evaluation Interval of 'Test Eval Group' …"
        /\bevaluation\s+interval\s+of\s+"([^"]+)"/i,
        /\bevaluation\s+interval\s+of\s+'([^']+)'/i,
        /\bevaluation\s+interval\s+of\s+([A-Za-z0-9][A-Za-z0-9 ._-]*?)(?=\s+to\b|[.,;\n]|$)/i,
    ];
    for (const re of patterns) {
        const m = text.match(re);
        if (m?.[1]?.trim()) {
            return m[1].trim().replace(/[.,;:]+$/, '');
        }
    }
    return undefined;
}

function extractEvalInterval(text: string): string | undefined {
    if (/\bevaluate[sd]?\s+every\s+minute\b/i.test(text)) {
        return '1m';
    }
    // "evaluates every five minutes" / "evaluate every 5 minutes" / "every 5m"
    const wordOrNum = text.match(
        /\bevaluate[sd]?\s+every\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|thirty)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hour|hours|d|day|days)\b/i
    );
    if (wordOrNum) {
        return toGrafanaDuration(wordOrNum[1], wordOrNum[2]);
    }
    const compact = text.match(/\bevaluate[sd]?\s+every\s+(\d+\s*[smhd])\b/i);
    if (compact?.[1]) {
        return compact[1].replace(/\s+/g, '').toLowerCase();
    }
    // "to be 2 minutes" / "to 2 minutes" / "to 2m"
    const toBe = text.match(
        /\bto\s+be\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|thirty)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hour|hours|d|day|days)\b/i
    );
    if (toBe) {
        return toGrafanaDuration(toBe[1], toBe[2]);
    }
    const toDur = text.match(
        /\bto\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|thirty)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hour|hours|d|day|days)\b/i
    );
    if (toDur) {
        return toGrafanaDuration(toDur[1], toDur[2]);
    }
    const toCompact = text.match(/\bto\s+(?:be\s+)?(\d+\s*[smhd])\b/i);
    if (toCompact?.[1]) {
        return toCompact[1].replace(/\s+/g, '').toLowerCase();
    }
    return undefined;
}

function extractPendingFor(text: string): string | undefined {
    if (/\b(?:true\s+for|remain(?:s|ed)?\s+true\s+for)\s+one\s+minute\b/i.test(text)) {
        return '1m';
    }
    // "remain true for longer than 1 minute" / "true for longer than five minutes"
    const longer = text.match(
        /\b(?:remain(?:s|ed)?\s+true\s+for|true\s+for|pending(?:\s+period)?)\s+(?:longer\s+than\s+)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|thirty)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hour|hours|d|day|days)\b/i
    );
    if (longer) {
        return toGrafanaDuration(longer[1], longer[2]);
    }
    const compact = text.match(/\b(?:true\s+for|pending(?:\s+period)?)\s+(\d+\s*[smhd])\b/i);
    if (compact?.[1]) {
        return compact[1].replace(/\s+/g, '').toLowerCase();
    }
    return undefined;
}

function extractQuotedField(text: string, field: 'summary' | 'description'): string | undefined {
    // "description of "X"" / "to have the description of "X"" / "make the summary "X"" / "description "X""
    const patterns = [
        new RegExp(
            `\\b(?:to\\s+have\\s+(?:the\\s+)?)?(?:(?:make|have|set|change|add)\\s+(?:a\\s+|the\\s+)?)?(?:the\\s+)?${field}\\s+of\\s+"([^"]*)"`,
            'i'
        ),
        new RegExp(
            `\\b(?:to\\s+have\\s+(?:the\\s+)?)?(?:(?:make|have|set|change|add)\\s+(?:a\\s+|the\\s+)?)?(?:the\\s+)?${field}\\s+of\\s+'([^']*)'`,
            'i'
        ),
        new RegExp(
            `\\b(?:make\\s+the\\s+|the\\s+|set\\s+(?:the\\s+)?)?${field}\\s+"([^"]*)"`,
            'i'
        ),
        new RegExp(
            `\\b(?:make\\s+the\\s+|the\\s+|set\\s+(?:the\\s+)?)?${field}\\s+'([^']*)'`,
            'i'
        ),
    ];
    for (const re of patterns) {
        const m = text.match(re);
        if (m?.[1] != null && m[1].trim()) {
            return m[1].trim();
        }
    }
    // "Add a description to the alarm titled … that says "X""
    if (field === 'description' || field === 'summary') {
        const withField =
            text.match(
                new RegExp(
                    `\\b(?:add|set|make|change)\\s+(?:a\\s+|the\\s+)?${field}\\b[\\s\\S]*?\\bthat\\s+says\\s+"([^"]*)"`,
                    'i'
                )
            ) ??
            text.match(
                new RegExp(
                    `\\b(?:add|set|make|change)\\s+(?:a\\s+|the\\s+)?${field}\\b[\\s\\S]*?\\bthat\\s+says\\s+'([^']*)'`,
                    'i'
                )
            );
        if (withField?.[1] != null && withField[1].trim()) {
            return withField[1].trim();
        }
        // Bare "that says" only for description prompts — never when the operator
        // is adding/changing a summary (would otherwise duplicate into description).
        if (
            field === 'description' &&
            !/\b(add|set|make|change)\s+(?:a\s+|the\s+)?summary\b/i.test(text)
        ) {
            const says =
                text.match(/\bthat\s+says\s+"([^"]*)"/i) ?? text.match(/\bthat\s+says\s+'([^']*)'/i);
            if (says?.[1] != null && says[1].trim()) {
                return says[1].trim();
            }
        }
    }
    // "Change the summary of the alert … to "X"" / "… to be "X""
    if (field === 'summary' || field === 'description') {
        const toQuoted =
            text.match(
                new RegExp(
                    `\\b(?:change|set|update|edit)\\s+(?:the\\s+)?${field}\\b[\\s\\S]*?\\bto\\s+(?:be\\s+)?"([^"]+)"`,
                    'i'
                )
            ) ??
            text.match(
                new RegExp(
                    `\\b(?:change|set|update|edit)\\s+(?:the\\s+)?${field}\\b[\\s\\S]*?\\bto\\s+(?:be\\s+)?'([^']+)'`,
                    'i'
                )
            );
        if (toQuoted?.[1] != null && toQuoted[1].trim()) {
            return toQuoted[1].trim();
        }
    }
    return undefined;
}

function extractLabel(text: string): Record<string, string> | undefined {
    // "label with a key of X and a value of Y"
    const keyed = text.match(
        /\blabel\s+with\s+(?:a\s+)?key\s+of\s+([A-Za-z0-9 ._-]+?)\s+and\s+(?:a\s+)?value\s+of\s+([A-Za-z0-9 ._-]+?)(?=[.,;\n]|$)/i
    );
    if (keyed?.[1]?.trim() && keyed[2]?.trim()) {
        return { [keyed[1].trim()]: keyed[2].trim().replace(/[.,;:]+$/, '') };
    }
    // "Add one label: key GraftAI Labels, value Alex"
    const colonKey = text.match(
        /\blabels?\s*:\s*key\s+([A-Za-z0-9 ._-]+?)\s*,\s*value\s+([A-Za-z0-9 ._-]+?)(?=[.,;\n]|$)/i
    );
    if (colonKey?.[1]?.trim() && colonKey[2]?.trim()) {
        return { [colonKey[1].trim()]: colonKey[2].trim().replace(/[.,;:]+$/, '') };
    }
    // label "key"="value" / label key=value
    const eq = text.match(/\blabel\s+"([^"]+)"\s*=\s*"([^"]+)"/i) ?? text.match(/\blabel\s+(\S+)\s*=\s*(\S+)/i);
    if (eq?.[1]?.trim() && eq[2]?.trim()) {
        return { [eq[1].trim()]: eq[2].trim().replace(/[.,;:]+$/, '') };
    }
    return undefined;
}

function extractCustomAnnotation(text: string): Record<string, string> | undefined {
    // 'custom annotation name of "X" and content of "Y"'
    const named = text.match(
        /\bcustom\s+annotation\s+name\s+of\s+"([^"]+)"\s+and\s+content\s+of\s+"([^"]+)"/i
    );
    if (named?.[1]?.trim() && named[2]?.trim()) {
        return { [named[1].trim()]: named[2].trim() };
    }
    const namedSingle = text.match(
        /\bcustom\s+annotation\s+name\s+of\s+'([^']+)'\s+and\s+content\s+of\s+'([^']+)'/i
    );
    if (namedSingle?.[1]?.trim() && namedSingle[2]?.trim()) {
        return { [namedSingle[1].trim()]: namedSingle[2].trim() };
    }
    // 'custom annotation name "X" with content "Y"'
    const withContent =
        text.match(/\bcustom\s+annotation\s+name\s+"([^"]+)"\s+with\s+content\s+"([^"]+)"/i) ??
        text.match(/\bcustom\s+annotation\s+name\s+'([^']+)'\s+with\s+content\s+'([^']+)'/i);
    if (withContent?.[1]?.trim() && withContent[2]?.trim()) {
        return { [withContent[1].trim()]: withContent[2].trim() };
    }
    return undefined;
}

function messageRestrictsExtraMetadata(text: string): boolean {
    return (
        /\bmake\s+no\s+other\s+(labels?|custom\s+annotations?|annotations?)\b/i.test(text) ||
        /\bno\s+(other|additional)\s+(labels?|custom\s+annotations?|annotations?)\b/i.test(text) ||
        /\bdo\s+not\s+add\s+(any\s+)?(other|additional)\s+(labels?|annotations?)\b/i.test(text) ||
        /\bonly\s+(the\s+)?(labels?|annotations?)\s+(?:i|we|you)\s+(?:asked|requested|specified)\b/i.test(
            text
        )
    );
}

export interface GrafanaAlertUpdateRequest {
    /**
     * Existing rule title to update.
     * Optional when panelTitle + dashboardUid identify the rule instead.
     */
    ruleTitle?: string;
    /** Optional dashboard UID to disambiguate when several rules share the title. */
    dashboardUid?: string;
    /** Optional panel title to disambiguate / verify the linked panel. */
    panelTitle?: string;
    contactPoint?: string;
    contactPointEmail?: string;
    createContactPoint?: boolean;
    /** Move the rule into this evaluation / rule group (created on save if new). */
    ruleGroup?: string;
    /** Evaluation interval for the (new) group, e.g. "1m". */
    every?: string;
    labels?: Record<string, string>;
    /** When true, replace labels/annotations with only the requested set. */
    restrictMetadata?: boolean;
    summary?: string;
    description?: string;
    customAnnotations?: Record<string, string>;
}

/**
 * True when the operator is updating an existing alert rule by name
 * (typically a small follow-up after a create), not creating from a panel.
 */
export function messageMentionsGrafanaAlertUpdate(message: string): boolean {
    const text = normalizeMessageQuotes(message.trim());
    if (!text) {
        return false;
    }
    // "assign the new rule" + panel + dashboard → create-from-panel, not metadata update.
    if (messageWantsAlertRuleBuiltFromPanel(text)) {
        return false;
    }

    // "Set the contact point as Alex Test Email for the GraftAI Rule on the panel …"
    // — does not require the phrase "alert rule named". Keep this narrow so full
    // create prompts (create contact point named …) are not stolen.
    if (
        /\b(set|assign|use)\s+(?:the\s+)?contact\s*point\s+(?:as|to)\b/i.test(text) &&
        extractContactPoint(text) &&
        extractRuleTitle(text) &&
        !(/\bcreate\b/i.test(text) && /\bpanel\s+titled\b/i.test(text))
    ) {
        return true;
    }

    const hasExplicitUpdate =
        /\b(update|edit|patch|modify|change)\s+(?:the\s+)?(?:grafana[- ]?managed\s+)?(?:alert|alarm)(?:\s+rule)?\b/i.test(
            text
        ) ||
        (/\b(update|edit|patch)\b/i.test(text) &&
            /\b(?:alert|alarm)(?:\s+rule)?\s+(?:named|titled|called)\b/i.test(text)) ||
        // "Change the summary/description of the alert for the panel titled …"
        /\b(change|set|update|edit|modify)\s+(?:the\s+)?(summary|description)\s+(?:of\s+)?(?:the\s+)?(?:alert|alarm)\b/i.test(
            text
        );
    const hasPanelRef =
        /\bpanel\s+(?:titled|named|called|of)\b/i.test(text) ||
        /\bfor\s+(?:the\s+)?panel\b/i.test(text) ||
        /\bon\s+(?:the\s+)?panel\b/i.test(text);
    const hasMetadataPatch =
        /\b(description|summary|label|annotation|notify|contact\s*point|evaluation\s+group|rule\s+group)\b/i.test(
            text
        );

    // "Change the alert for the panel titled … to have the description of …"
    // — identify the rule by panel + dashboard, not by "alert rule named".
    if (
        hasExplicitUpdate &&
        hasPanelRef &&
        hasMetadataPatch &&
        !/\bcreate\b/i.test(text)
    ) {
        return true;
    }

    // "Add a description to the alarm titled … that says …"
    // Do not steal full creates that also say "Make the summary/description …".
    if (
        /\b(add|set|make)\s+(?:a\s+|the\s+)?(description|summary|label|annotation)\b/i.test(text) &&
        /\b(?:alert|alarm)(?:\s+rule)?\s+(?:named|titled|called)\b/i.test(text) &&
        !(
            /\bcreate\b/i.test(text) &&
            (/\bpanel\s+titled\b/i.test(text) ||
                /\bfor\s+(?:the\s+)?panel\b/i.test(text) ||
                /\bgrafana[- ]?managed\s+alert\b/i.test(text))
        )
    ) {
        return true;
    }

    const hasNamedRule =
        /\b(?:alert|alarm)(?:\s+rule)?\s+(?:named|titled|called)\s+/i.test(text) ||
        /\balert\s+rule\s+(?:titled|called)\s+/i.test(text);
    if (!hasNamedRule) {
        return false;
    }

    // Full create: "Create a Grafana-managed alert named X for the panel titled…"
    // Must NOT match when the prompt centers on Update of an existing rule —
    // operators often include dashboard UID / panel name as disambiguators on updates.
    const isFullAlertCreateFromPanel =
        !hasExplicitUpdate &&
        /\bcreate\b/i.test(text) &&
        /\b(grafana[- ]?managed\s+)?(?:alert|alarm)\b/i.test(text) &&
        (/\bpanel\s+titled\b/i.test(text) ||
            /\bfor\s+(?:the\s+)?panel\b/i.test(text) ||
            /\bdashboard\s+with\s+uid\b/i.test(text));
    if (isFullAlertCreateFromPanel) {
        return false;
    }

    // Explicit update of a named rule — dashboard/panel context is optional disambiguation.
    if (hasExplicitUpdate) {
        return true;
    }

    // Metadata / evaluation-group follow-up on a named rule (no "Update" verb).
    return (
        /\b(add|set|make|create)\b/i.test(text) &&
        /\b(label|summary|description|annotation|notify|contact\s*point|evaluation\s+group|rule\s+group)\b/i.test(
            text
        )
    );
}

export function parseGrafanaAlertUpdateRequest(message: string): GrafanaAlertUpdateRequest | null {
    const text = normalizeMessageQuotes(message.trim());
    if (!messageMentionsGrafanaAlertUpdate(text)) {
        return null;
    }
    const ruleTitle = extractRuleTitle(text);
    const panelTitle = extractQuotedPanelTitle(text);
    const dashboardUid =
        extractAllDashboardUids(text)[0] ?? extractDashboardUidFromMessage(text);
    // Need either a rule name, or panel + dashboard to locate the existing rule.
    if (!ruleTitle && !(panelTitle && dashboardUid)) {
        return null;
    }
    // Require at least one patchable field so vague "change the alert…" is not empty.
    const summary = extractQuotedField(text, 'summary');
    const description = extractQuotedField(text, 'description');
    const labels = extractLabel(text);
    const customAnnotations = extractCustomAnnotation(text);
    const contactPoint = extractContactPoint(text);
    const ruleGroup = extractRuleGroup(text);
    const hasPatch =
        Boolean(summary) ||
        Boolean(description) ||
        Boolean(labels) ||
        Boolean(customAnnotations) ||
        Boolean(contactPoint) ||
        Boolean(ruleGroup);
    if (!hasPatch) {
        return null;
    }
    return {
        ruleTitle,
        dashboardUid,
        panelTitle,
        contactPoint,
        contactPointEmail: extractContactPointEmail(text),
        createContactPoint: messageWantsNewContactPoint(text),
        ruleGroup,
        every: extractEvalInterval(text),
        labels,
        restrictMetadata: messageRestrictsExtraMetadata(text),
        summary,
        description,
        customAnnotations,
    };
}

export interface GrafanaEvalGroupIntervalRequest {
    ruleGroup: string;
    every: string;
}

/**
 * "Change the Evaluation Interval of 'Test Eval Group' to be 2 minutes."
 * — group-level interval change, not a rule create/update.
 */
export function messageMentionsGrafanaEvalGroupIntervalChange(message: string): boolean {
    const text = normalizeMessageQuotes(message.trim());
    if (!text) {
        return false;
    }
    if (!/\bevaluation\s+interval\b/i.test(text)) {
        return false;
    }
    if (!/\b(change|set|update|make)\b/i.test(text)) {
        return false;
    }
    // Avoid stealing full alert-rule creates that also mention evaluation interval.
    if (/\bpanel\s+titled\b/i.test(text) || messageWantsAlertRuleBuiltFromPanel(text)) {
        return false;
    }
    return (
        /\bof\s+["'][^"']+["']/i.test(text) ||
        /\b(?:evaluation|rule|eval)\s+group\b/i.test(text) ||
        /\bevaluation\s+interval\s+of\s+[A-Za-z0-9]/i.test(text)
    );
}

export function parseGrafanaEvalGroupIntervalRequest(
    message: string
): GrafanaEvalGroupIntervalRequest | null {
    const text = normalizeMessageQuotes(message.trim());
    if (!messageMentionsGrafanaEvalGroupIntervalChange(text)) {
        return null;
    }
    const ruleGroup = extractRuleGroup(text);
    const every = extractEvalInterval(text);
    if (!ruleGroup || !every) {
        return null;
    }
    return { ruleGroup, every };
}

export function parseGrafanaAlertCreateRequest(
    message: string,
    opts?: { contextDashboardUid?: string }
): GrafanaAlertCreateRequest | null {
    const text = normalizeMessageQuotes(message.trim());
    // Group-level interval changes are not alert-rule creates.
    if (messageMentionsGrafanaEvalGroupIntervalChange(text) && parseGrafanaEvalGroupIntervalRequest(text)) {
        return null;
    }
    const buildFromPanel = messageWantsAlertRuleBuiltFromPanel(text);
    // Prefer the update path for small follow-up prompts (no panel/dashboard),
    // unless this is a hybrid "new rule for panel" create.
    if (
        !buildFromPanel &&
        messageMentionsGrafanaAlertUpdate(text) &&
        parseGrafanaAlertUpdateRequest(text)
    ) {
        return null;
    }
    if (!messageMentionsGrafanaAlertCreate(text)) {
        return null;
    }
    const dashboardUid =
        extractAllDashboardUids(text)[0] ??
        extractDashboardUidFromMessage(text) ??
        (opts?.contextDashboardUid?.trim() || undefined);
    const panelTitle = extractQuotedPanelTitle(text);
    const contactPoint = extractContactPoint(text);
    const contactPointEmail = extractContactPointEmail(text);
    const createContactPoint = messageWantsNewContactPoint(text);
    const ruleTitle = extractRuleTitle(text);
    const folderTitle = extractFolderTitle(text);
    const ruleGroup = extractRuleGroup(text);
    const every = extractEvalInterval(text);
    const pendingFor = extractPendingFor(text);
    const summary = extractQuotedField(text, 'summary');
    const description = extractQuotedField(text, 'description');
    const labels = extractLabel(text);
    const customAnnotations = extractCustomAnnotation(text);
    const restrictMetadata = messageRestrictsExtraMetadata(text);

    // Do not assume Own History ±2σ when the prompt did not say so.
    let conditionSummary =
        'the panel Actual series is outside its existing Upper and Lower bound series (Last reducer; no invented threshold)';
    const peerRfAlert = messageLooksLikePeerRfAlert(text);
    if (peerRfAlert) {
        conditionSummary =
            'Module Current is outside the RandomForest vs Peers upper/lower bands already defined by the model (no invented threshold)';
        const mod = text.match(/\bmodule\s*(\d+)\b/i)?.[1];
        if (mod) {
            conditionSummary =
                `Module ${mod} Current is outside the RandomForest vs Peers upper/lower bands already defined by the model (no invented threshold)`;
        }
    } else if (/\bown\s+history\b/i.test(text) || (/\bactual\b/i.test(text) && /\bupper\b/i.test(text) && /\blower\b/i.test(text))) {
        conditionSummary =
            'Actual > Upper Bound (±2σ) **OR** Actual < Lower Bound (±2σ) (Last reducer on each series)';
    }

    return {
        dashboardUid,
        panelTitle,
        contactPoint,
        contactPointEmail,
        createContactPoint,
        ruleTitle,
        folderTitle,
        ruleGroup,
        every,
        pendingFor,
        labels,
        restrictMetadata,
        summary,
        description,
        customAnnotations,
        buildFromPanel,
        conditionSummary,
        peerRfAlert,
    };
}

/**
 * When automatic create cannot finish, ask for the missing piece.
 * Do not dump a competing Grafana UI cookbook (that made operators think
 * Graft only writes instructions, and it guessed Own History steps for RF alerts).
 */
export function formatGrafanaAlertGuidanceReply(
    request: GrafanaAlertCreateRequest,
    buildNumber: number,
    apiError?: string
): string {
    const panel = request.panelTitle ?? 'your panel';
    const dash = request.dashboardUid
        ? `dashboard uid \`${request.dashboardUid}\``
        : 'the dashboard open in Grafana (or paste UID from the URL after `/d/`)';
    const contact = request.contactPoint ?? 'your contact point (e.g. Alex Test Email)';
    const every = request.every ?? '1m';
    const pendingFor = request.pendingFor ?? '1m';
    const errorBlock = apiError
        ? `**Automatic create failed:** ${apiError}\n\n`
        : `Graft tried the provisioning API and could not finish automatically.\n\n`;

    const kindLine = request.peerRfAlert
        ? `This request is a **RandomForest vs Peers** alert. Graft will **not** invent a RandomForest threshold, fake model output, or switch to Own History / Peer Band ±2σ.\n\n`
        : `Graft will use the **existing** Actual / Upper / Lower series on the named panel (Reduce **Last**). It will **not** invent a threshold or switch panel types.\n\n`;

    const rfExtra = request.peerRfAlert
        ? `If the panel has Actual + Expected but **no Upper/Lower Bound (Peer RF)** series, the model output is incomplete — recreate that RandomForest vs Peers panel first, then ask again.\n\n`
        : '';

    return (
        `### Need clarification — Grafana alert (Graft build ${buildNumber})\n\n` +
        errorBlock +
        kindLine +
        `**Intended rule:** ${request.conditionSummary} on **${panel}** (${dash}), notify **${contact}**, evaluate **${every}**, pending **${pendingFor}**.\n\n` +
        `**Reply with the missing piece, then send the same create request.** Do not build the rule in the Grafana UI unless you want to — Graft should create it once lookup succeeds.\n` +
        `1. Full dashboard UID from the URL (the part after \`/d/\` — short prefixes like \`idHkqdqnk\` are often incomplete).\n` +
        `2. Exact panel title as shown on the dashboard (titles often end with **(Influx)**).\n` +
        `3. Contact point name, or \`notify … using you@email\` so Graft can create it.\n\n` +
        rfExtra +
        `**Permissions:** Editor (or Admin) on the alert folder. Viewers cannot create rules.`
    );
}
