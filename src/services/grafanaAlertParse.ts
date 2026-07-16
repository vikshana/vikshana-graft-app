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
    /** Human description of the breach condition. */
    conditionSummary: string;
}

function normalizeMessageQuotes(text: string): string {
    return text.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
}

/** True when the user is asking to create/configure a Grafana alert or alert rule. */
export function messageMentionsGrafanaAlertCreate(message: string): boolean {
    const text = normalizeMessageQuotes(message.trim());
    if (!text) {
        return false;
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

function extractQuotedPanelTitle(text: string): string | undefined {
    const patterns = [
        /\bpanel\s+titled\s+"([^"]+)"/i,
        /\bpanel\s+titled\s+'([^']+)'/i,
        /\bpanel\s+(?:named|called)\s+"([^"]+)"/i,
        /\bpanel\s+(?:named|called)\s+'([^']+)'/i,
    ];
    for (const re of patterns) {
        const m = text.match(re);
        if (m?.[1]?.trim()) {
            return m[1].trim();
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
    // Prefer "alert named X" / "alert rule named X" before contact-point "named".
    const patterns = [
        /\b(?:grafana[- ]?managed\s+)?alert(?:\s+rule)?\s+named\s+"([^"]+)"/i,
        /\b(?:grafana[- ]?managed\s+)?alert(?:\s+rule)?\s+named\s+'([^']+)'/i,
        /\b(?:grafana[- ]?managed\s+)?alert(?:\s+rule)?\s+named\s+([A-Za-z0-9][A-Za-z0-9 ._-]*?)(?=\s+for\s+(?:the\s+)?panel\b|\s+on\s+the\s+dashboard\b|[.,;\n]|$)/i,
        /\balert\s+rule\s+(?:titled|called)\s+"([^"]+)"/i,
        /\balert\s+rule\s+(?:titled|called)\s+'([^']+)'/i,
    ];
    for (const re of patterns) {
        const m = text.match(re);
        if (m?.[1]?.trim()) {
            return m[1].trim().replace(/[.,;:]+$/, '');
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
        /\bevaluation\s+group\s+named\s+"([^"]+)"/i,
        /\bevaluation\s+group\s+named\s+'([^']+)'/i,
        /\bevaluation\s+group\s+named\s+([A-Za-z0-9][A-Za-z0-9 ._-]*?)(?=\s+that\b|\s+evaluat|\s+with\b|[.,;\n]|$)/i,
        /\brule\s+group\s+named\s+"([^"]+)"/i,
        /\brule\s+group\s+named\s+([A-Za-z0-9][A-Za-z0-9 ._-]*?)(?=\s+that\b|\s+evaluat|[.,;\n]|$)/i,
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
    const re = new RegExp(
        `\\b(?:make\\s+the\\s+|the\\s+|set\\s+(?:the\\s+)?)?${field}\\s+"([^"]+)"`,
        'i'
    );
    const m = text.match(re);
    if (m?.[1]?.trim()) {
        return m[1].trim();
    }
    const single = new RegExp(
        `\\b(?:make\\s+the\\s+|the\\s+|set\\s+(?:the\\s+)?)?${field}\\s+'([^']+)'`,
        'i'
    );
    const m2 = text.match(single);
    return m2?.[1]?.trim();
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
    /** Existing rule title to update (required). */
    ruleTitle: string;
    contactPoint?: string;
    contactPointEmail?: string;
    createContactPoint?: boolean;
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
    const hasNamedRule =
        /\balert(?:\s+rule)?\s+named\s+/i.test(text) ||
        /\balert\s+rule\s+(?:titled|called)\s+/i.test(text);
    if (!hasNamedRule) {
        return false;
    }
    // Full create prompts often say "modify the panel queries" / "change …" — those are not updates.
    const hasPanelCreate =
        /\bpanel\s+titled\b/i.test(text) ||
        /\bdashboard\s+with\s+uid\b/i.test(text) ||
        (/\bcreate\b/i.test(text) && /\bfor\s+(?:the\s+)?panel\b/i.test(text));
    if (hasPanelCreate) {
        return false;
    }
    // Explicit update verbs on a named rule (no panel/dashboard create context).
    if (/\b(update|edit|modify|patch|change)\b/i.test(text)) {
        return true;
    }
    // Metadata-only follow-up: add label/summary/annotation/notify to a named rule.
    return (
        /\b(add|set|make)\b/i.test(text) &&
        /\b(label|summary|description|annotation|notify|contact\s*point)\b/i.test(text)
    );
}

export function parseGrafanaAlertUpdateRequest(message: string): GrafanaAlertUpdateRequest | null {
    const text = normalizeMessageQuotes(message.trim());
    if (!messageMentionsGrafanaAlertUpdate(text)) {
        return null;
    }
    const ruleTitle = extractRuleTitle(text);
    if (!ruleTitle) {
        return null;
    }
    // Full create prompts that also say "named" should stay on the create path.
    if (
        /\bpanel\s+titled\b/i.test(text) &&
        (/\bdashboard\s+with\s+uid\b/i.test(text) || /\bcreate\b/i.test(text))
    ) {
        return null;
    }
    return {
        ruleTitle,
        contactPoint: extractContactPoint(text),
        contactPointEmail: extractContactPointEmail(text),
        createContactPoint: messageWantsNewContactPoint(text),
        labels: extractLabel(text),
        restrictMetadata: messageRestrictsExtraMetadata(text),
        summary: extractQuotedField(text, 'summary'),
        description: extractQuotedField(text, 'description'),
        customAnnotations: extractCustomAnnotation(text),
    };
}

export function parseGrafanaAlertCreateRequest(message: string): GrafanaAlertCreateRequest | null {
    const text = normalizeMessageQuotes(message.trim());
    // Prefer the update path for small follow-up prompts (no panel/dashboard).
    if (messageMentionsGrafanaAlertUpdate(text) && parseGrafanaAlertUpdateRequest(text)) {
        return null;
    }
    if (!messageMentionsGrafanaAlertCreate(text)) {
        return null;
    }
    const dashboardUid = extractAllDashboardUids(text)[0] ?? extractDashboardUidFromMessage(text);
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

    let conditionSummary = 'Actual value breaches its Upper or Lower Bound (±2σ)';
    if (/\bactual\b/i.test(text) && /\bupper\b/i.test(text) && /\blower\b/i.test(text)) {
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
        conditionSummary,
    };
}

/**
 * Manual UI fallback when provisioning API create fails (permissions, missing
 * contact point, General folder, etc.).
 */
export function formatGrafanaAlertGuidanceReply(
    request: GrafanaAlertCreateRequest,
    buildNumber: number,
    apiError?: string
): string {
    const panel = request.panelTitle ?? 'your panel';
    const dash = request.dashboardUid
        ? `dashboard uid \`${request.dashboardUid}\``
        : 'the Keysight dashboard';
    const contact = request.contactPoint ?? 'your contact point (e.g. Alex Test Email)';
    const every = request.every ?? '1m';
    const pendingFor = request.pendingFor ?? '1m';
    const errorBlock = apiError
        ? `**Automatic create failed:** ${apiError}\n\nUse the steps below in the Grafana UI.\n\n`
        : `Graft tried the provisioning API and could not finish automatically. Use the steps below.\n\n`;

    return (
        `### Grafana alerts — how to create this (build ${buildNumber})\n\n` +
        errorBlock +
        `**Goal:** Alert when **${request.conditionSummary}** on panel **${panel}** (${dash}), ` +
        `notify **${contact}**.\n\n` +
        `#### 1. Open a new Grafana-managed alert rule\n` +
        `1. Left menu → **Alerts & IRM** → **Alert rules** → **+ New alert rule**\n` +
        `2. Name: e.g. \`Module 2 Current outside Own History ±2σ\`\n\n` +
        `#### 2. Prefer starting from the panel\n` +
        `1. Open ${dash}\n` +
        `2. Find **${panel}** → panel menu (▼) → **More…** → **New alert rule** (Grafana copies the Flux queries)\n` +
        `   If that menu item is missing, create the rule from **Alert rules** and use **Link dashboard and panel** in annotations.\n\n` +
        `#### 3. Define queries + condition (Advanced)\n` +
        `Switch to **Advanced** so you can Reduce multiple series:\n\n` +
        `1. Keep the panel queries (typical Own History layout):\n` +
        `   - **A** — Module Actual\n` +
        `   - **C** — Upper Bound (±2σ)\n` +
        `   - **D** — Lower Bound (±2σ)\n` +
        `   (Match by legend if refIds differ; you need Actual, Upper, and Lower.)\n` +
        `2. **Add expression → Reduce** three times — Function **Last** — one for Actual, one for Upper, one for Lower\n` +
        `3. **Add expression → Math** (use the Reduce refIds Grafana shows, example names \`E\`, \`F\`, \`G\`):\n` +
        '   ```\n' +
        '   $E > $F || $E < $G\n' +
        '   ```\n' +
        `   Meaning: last(Actual) > last(Upper) **OR** last(Actual) < last(Lower).\n` +
        `4. Click **Set as alert condition** on that Math expression.\n` +
        `5. **Preview** — you want \`1\` when Actual is outside the band, \`0\` when inside.\n\n` +
        `#### 4. Evaluation\n` +
        `1. Evaluation group interval: **${every}**\n` +
        `2. Pending period (**for**): **${pendingFor}** (must stay true before the alert fires)\n\n` +
        `#### 5. Notifications\n` +
        `1. **Configure notifications** → **Select contact point**\n` +
        `2. Choose **${contact}**\n` +
        `3. If it is missing: **Alerts & IRM → Contact points → + Add contact point** → type **Email** → ` +
        `name it exactly **${contact}** → add address → **Save contact point**\n\n` +
        `#### 6. Save\n` +
        `1. Pick a folder (Keysight’s folder is fine)\n` +
        `2. **Save rule** → hard-refresh the dashboard and confirm the panel shows a linked alert\n\n` +
        `**Permissions:** Editor (or Admin) on the alert folder. Viewers cannot create rules.`
    );
}
