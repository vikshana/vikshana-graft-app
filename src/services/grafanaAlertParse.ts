import { extractAllDashboardUids, extractDashboardUidFromMessage } from './dashboardMentionParse';

export interface GrafanaAlertCreateRequest {
    dashboardUid?: string;
    panelTitle?: string;
    contactPoint?: string;
    /** Evaluation interval, e.g. "1m". */
    every?: string;
    /** Pending duration before firing, e.g. "1m". */
    pendingFor?: string;
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

function extractContactPoint(text: string): string | undefined {
    const named = text.match(
        /\b(?:notify|notifications?\s+to)\s+(?:the\s+)?(.+?)\s+contact\s*point\b/i
    );
    if (named?.[1]?.trim()) {
        return named[1].trim().replace(/^["']|["']$/g, '');
    }
    const sendTo = text.match(/\bSend\s+notifications\s+to\s+([^.!\n]+)/i);
    if (sendTo?.[1]?.trim()) {
        return sendTo[1].trim().replace(/^["']|["']$/g, '');
    }
    const quoted = text.match(/\bcontact\s*point\s+["']([^"']+)["']/i);
    if (quoted?.[1]?.trim()) {
        return quoted[1].trim();
    }
    return undefined;
}

export function parseGrafanaAlertCreateRequest(message: string): GrafanaAlertCreateRequest | null {
    const text = normalizeMessageQuotes(message.trim());
    if (!messageMentionsGrafanaAlertCreate(text)) {
        return null;
    }
    const dashboardUid = extractAllDashboardUids(text)[0] ?? extractDashboardUidFromMessage(text);
    const panelTitle = extractQuotedPanelTitle(text);
    const contactPoint = extractContactPoint(text);
    const every = /evaluate\s+every\s+minute\b/i.test(text)
        ? '1m'
        : text.match(/\bevaluate\s+every\s+(\d+\s*[smhd])\b/i)?.[1]?.replace(/\s+/g, '').toLowerCase();
    const pendingFor = /true\s+for\s+one\s+minute\b/i.test(text)
        ? '1m'
        : text.match(/\b(?:true\s+for|pending(?:\s+period)?)\s+(\d+\s*[smhd])\b/i)?.[1]
              ?.replace(/\s+/g, '')
              .toLowerCase();

    let conditionSummary = 'Actual value breaches its Upper or Lower Bound (±2σ)';
    if (/\bactual\b/i.test(text) && /\bupper\b/i.test(text) && /\blower\b/i.test(text)) {
        conditionSummary =
            'Actual > Upper Bound (±2σ) **OR** Actual < Lower Bound (±2σ) (Last reducer on each series)';
    }

    return {
        dashboardUid,
        panelTitle,
        contactPoint,
        every,
        pendingFor,
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
