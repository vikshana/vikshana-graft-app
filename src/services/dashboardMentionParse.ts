/** Captures a Grafana dashboard uid after the word "uid" (uid=abc, uid "abc", uid:'abc'). */
export const DASHBOARD_UID_AFTER_LABEL = /uid\s*[=:#]?\s*["']?([a-zA-Z0-9]{6,})["']?/i;

function collectUidMatches(text: string, pattern: RegExp): string[] {
    const ids: string[] = [];
    for (const m of text.matchAll(pattern)) {
        if (m[1]) {
            ids.push(m[1]);
        }
    }
    return ids;
}

const NOT_A_DASHBOARD_UID = new Set([
    'keysight',
    'skywater',
    'electramet',
    'exsolve',
    'grafana',
    'overview',
    'sandbox',
    'production',
    'machine',
    'dashboard',
    'current',
    'pressure',
    'temperature',
    'module',
    'glentest',
]);

/** Grafana short uids are mixed-case and/or contain digits — not vendor words like Keysight. */
export function looksLikeGrafanaDashboardUid(token: string): boolean {
    if (!token || token.length < 8 || token.length > 40) {
        return false;
    }
    if (!/^[A-Za-z0-9]+$/.test(token)) {
        return false;
    }
    if (/^[0-9]{4}-[0-9]{6,}$/.test(token)) {
        return false;
    }
    if (NOT_A_DASHBOARD_UID.has(token.toLowerCase())) {
        return false;
    }
    if (/^[A-Z][a-z]{5,}$/.test(token)) {
        return false;
    }
    const hasLetter = /[A-Za-z]/.test(token);
    const hasDigit = /\d/.test(token);
    const mixedCase = /[a-z]/.test(token) && /[A-Z]/.test(token);
    return hasLetter && (hasDigit || mixedCase);
}

/** Trailing / "on dashboard X" uids: require a digit or a leading lowercase (idHkqdqnk), not CamelCase names. */
function looksLikeBareDashboardUid(token: string): boolean {
    if (!looksLikeGrafanaDashboardUid(token)) {
        return false;
    }
    if (/\d/.test(token)) {
        return true;
    }
    return /^[a-z]/.test(token);
}

/** Vendor/site words operators sometimes type as uid=Keysight. */
export function isVendorNameUsedAsDashboardUid(token: string): boolean {
    const t = token.trim();
    if (!t) {
        return false;
    }
    if (NOT_A_DASHBOARD_UID.has(t.toLowerCase())) {
        return true;
    }
    if (/\d/.test(t)) {
        return false;
    }
    if (/^[a-z]/.test(t)) {
        return false;
    }
    return /^[A-Z][A-Za-z-]*$/.test(t) && t.length <= 24;
}

/** `uid=Keysight` / `UID = Skywater` — not a Grafana uid. */
export function extractClaimedVendorDashboardUid(message: string): string | undefined {
    const m = message.match(/\buid\s*[=:#]?\s*["']?([A-Za-z][A-Za-z0-9_-]+)/i);
    if (m?.[1] && isVendorNameUsedAsDashboardUid(m[1])) {
        return m[1];
    }
    return undefined;
}

/** User referred to a Grafana dashboard (incl. "dash board" typo and uid-in-quotes). */
export function mentionsDashboard(message: string): boolean {
    return (
        /\bdashboard\b/i.test(message) ||
        /\bdash\s*board\b/i.test(message) ||
        (/\buid\b/i.test(message) && /["'][a-zA-Z0-9]{6,}["']/i.test(message))
    );
}

/** Grafana dashboard uid from natural phrasing. */
export function extractDashboardUidFromMessage(message: string): string | undefined {
    const text = message.trim();
    const patterns = [
        /\bhas\s+the\s+UID\s*["']([a-zA-Z0-9]+)["']/i,
        /\bUID\s*["']([a-zA-Z0-9]+)["']/i,
        /\bdash\s*board\s*["']([a-zA-Z0-9]+)["']/i,
        /\bdashboard\s+(?:with\s+)?uid\s*[=:#]?\s*["']?([a-zA-Z0-9]{6,})["']?/i,
        /\bdashboard\s+["']([a-zA-Z0-9]{6,})["']/i,
        DASHBOARD_UID_AFTER_LABEL,
        // Bare "dashboard <uid>" — uid is 9+ alphanumerics containing at least one
        // letter (so pure numbers / hyphenated machine ids don't match). Grafana
        // uids may start with a digit (e.g. "6gawrgawrgragg").
        /\b(?:the\s+)?dashboard\s+(?=[a-z0-9]*[a-z])([a-z0-9]{9,})\b/i,
    ];
    for (const re of patterns) {
        const m = text.match(re);
        if (m?.[1] && !isVendorNameUsedAsDashboardUid(m[1])) {
            return m[1];
        }
    }
    return undefined;
}

/** All Grafana dashboard uids mentioned in a message (deduped, order preserved). */
export function extractAllDashboardUids(message: string): string[] {
    const text = message.trim();
    const ids: string[] = [];
    ids.push(...collectUidMatches(text, /\bhas\s+the\s+UID\s*["']([a-zA-Z0-9]+)["']/gi));
    ids.push(...collectUidMatches(text, /\bwith\s+the\s+UID\s*[=:#]?\s*["']?([a-zA-Z0-9]{6,})["']?/gi));
    ids.push(...collectUidMatches(text, /\bUID\s*["']([a-zA-Z0-9]+)["']/gi));
    ids.push(...collectUidMatches(text, /\bdash\s*board\s*["']([a-zA-Z0-9]+)["']/gi));
    ids.push(
        ...collectUidMatches(text, /\bdashboard\s+(?:with\s+(?:the\s+)?)?uid\s*[=:#]?\s*["']?([a-zA-Z0-9]{6,})["']?/gi)
    );
    ids.push(...collectUidMatches(text, /\bdashboard\s*["']([a-zA-Z0-9]{6,})["']/gi));
    ids.push(...collectUidMatches(text, new RegExp(`\\b${DASHBOARD_UID_AFTER_LABEL.source}`, 'gi')));
    // "for the 6sFerv44k machine" — Grafana uid used as a machine handle, not "Keysight"
    ids.push(
        ...collectUidMatches(
            text,
            /\bfor\s+(?:the\s+)?([A-Za-z0-9]*[A-Za-z][A-Za-z0-9]{5,13})\s+machine\b/gi
        ).filter(looksLikeGrafanaDashboardUid)
    );
    ids.push(
        ...collectUidMatches(text, /\bfor\s+([A-Za-z][A-Za-z0-9]{7,})\b/gi).filter(looksLikeBareDashboardUid)
    );
    ids.push(
        ...collectUidMatches(
            text,
            /\b(?:rename|retitle|call)\s+(?:the\s+)?([A-Za-z0-9]{8,})\s+dashboard\b/gi
        ).filter(
            looksLikeBareDashboardUid
        )
    );
    ids.push(
        ...collectUidMatches(text, /\bon\s+(?:the\s+)?dashboard\s+([A-Za-z0-9]{8,})\b/gi).filter(
            looksLikeBareDashboardUid
        )
    );
    ids.push(
        ...collectUidMatches(text, /\bon\s+([A-Za-z][A-Za-z0-9]{7,})\b/gi).filter(looksLikeBareDashboardUid)
    );
    ids.push(
        ...collectUidMatches(text, /\b(?:on|to)\s+([A-Za-z][A-Za-z0-9]{7,})\s*[.]?$/gi).filter(
            looksLikeBareDashboardUid
        )
    );
    ids.push(
        ...collectUidMatches(text, /\b(?:the\s+)?([A-Za-z0-9]{8,})\s+dashboard\b/gi).filter(
            looksLikeBareDashboardUid
        )
    );
    return [
        ...new Set(
            ids.filter((id) => !/^[0-9]{4}-[0-9]{6,}$/.test(id) && !isVendorNameUsedAsDashboardUid(id))
        ),
    ];
}

/** Grafana panel id from "panel id 35" — NOT the same as array index. */
export function extractPanelIdFromMessage(message: string): number | undefined {
    const patterns = [
        /\bpanel\s*id\s*#?\s*(\d+)/i,
        /\bpanelid\s*#?\s*(\d+)/i,
        // Bare "panel 35" / "in panel #35". Does not match "panel index 35" or
        // "array index 35" (those are handled by extractPanelArrayIndexFromMessage).
        /\bpanel\s*#?\s*(\d+)\b/i,
    ];
    for (const re of patterns) {
        const m = message.match(re);
        if (m?.[1]) {
            const n = Number(m[1]);
            if (Number.isFinite(n)) {
                return n;
            }
        }
    }
    return undefined;
}

/** Top-level arrayIndex from "panel index 35", "array index 35". */
export function extractPanelArrayIndexFromMessage(message: string): number | undefined {
    const patterns = [
        /\b(?:panel|array)\s*index\s*#?\s*(\d+)/i,
        /\barrayindex\s*#?\s*(\d+)/i,
    ];
    for (const re of patterns) {
        const m = message.match(re);
        if (m?.[1]) {
            const n = Number(m[1]);
            if (Number.isFinite(n)) {
                return n;
            }
        }
    }
    return undefined;
}

/** Panel title from named / titled / which is named phrasing. */
export function extractPanelTitleFromMessage(message: string): string | undefined {
    const patterns = [
        /\b(?:which\s+is\s+)?named\s+[""]([^""]+)[""]/i,
        /\b(?:which\s+is\s+)?named\s+"([^"]+)"/i,
        /\btitled\s+[""]([^""]+)[""]/i,
        /\btitled\s+"([^"]+)"/i,
        /\bpanel\s+named\s+[""]([^""]+)[""]/i,
        /\bpanel\s+named\s+"([^"]+)"/i,
    ];
    for (const re of patterns) {
        const m = message.match(re);
        if (m?.[1]?.trim()) {
            return m[1].trim().replace(/[.\s]+$/u, '');
        }
    }
    return undefined;
}
