type PanelRecord = Record<string, unknown>;

/** Fix common invalid Flux tokens seen on Influx-backed anomaly panels. */
export function sanitizeFluxQueryString(query: string): { query: string; changed: boolean } {
    let out = query;
    let changed = false;

    const replacements: Array<[RegExp, string]> = [
        [/\bstdDev\b/g, 'stddev'],
        [/\bmean_val\b/g, '_mean'],
        [/\bgroup\s*\(\s*by\s*:/gi, 'group(columns: ['],
        [/\|\>\s*group\s*\(\s*by\b/gi, '|> group(columns: ['],
        [/\|\>\s*group\s*\(\s*\)/g, '|> group()'],
    ];

    for (const [pattern, replacement] of replacements) {
        const next = out.replace(pattern, replacement);
        if (next !== out) {
            out = next;
            changed = true;
        }
    }

    return { query: out, changed };
}

function isLikelyFluxTarget(target: Record<string, unknown>): boolean {
    const ds = target.datasource;
    const dsType =
        typeof ds === 'object' && ds !== null
            ? String((ds as { type?: string }).type ?? '').toLowerCase()
            : '';
    if (dsType.includes('influx')) {
        return true;
    }
    const q = String(target.query ?? target.expr ?? target.rawQuery ?? '');
    return (
        /\bfrom\s*\(/i.test(q) ||
        /\bstddev\b/i.test(q) ||
        /\bstdDev\b/.test(q) ||
        /\bmean_val\b/.test(q) ||
        /\baggregateWindow\b/i.test(q) ||
        /\|>\s*group\b/i.test(q)
    );
}

function fixQueryField(target: PanelRecord, field: string): boolean {
    const raw = target[field];
    if (typeof raw !== 'string' || !raw.trim()) {
        return false;
    }
    const { query, changed } = sanitizeFluxQueryString(raw);
    if (changed) {
        target[field] = query;
    }
    return changed;
}

function fixTargetLikeObject(obj: PanelRecord, aggressive: boolean): boolean {
    if (!aggressive && !isLikelyFluxTarget(obj)) {
        return false;
    }
    let changed = false;
    for (const field of ['query', 'expr', 'rawQuery', 'queryText']) {
        if (fixQueryField(obj, field)) {
            changed = true;
        }
    }
    return changed;
}

/** Recursively sanitize Flux-like strings anywhere under a panel (targets, queries, nested models). */
export function deepSanitizeFluxStrings(value: unknown, aggressive: boolean): { value: unknown; changed: boolean } {
    if (typeof value === 'string') {
        if (!aggressive && !/\b(stdDev|mean_val|from\s*\(|aggregateWindow|\|>)/i.test(value)) {
            return { value, changed: false };
        }
        const { query, changed } = sanitizeFluxQueryString(value);
        return { value: query, changed };
    }
    if (Array.isArray(value)) {
        let changed = false;
        const next = value.map((item) => {
            const r = deepSanitizeFluxStrings(item, aggressive);
            if (r.changed) {
                changed = true;
            }
            return r.value;
        });
        return { value: next, changed };
    }
    if (value && typeof value === 'object') {
        let changed = false;
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            const r = deepSanitizeFluxStrings(v, aggressive);
            out[k] = r.value;
            if (r.changed) {
                changed = true;
            }
        }
        return { value: out, changed };
    }
    return { value, changed: false };
}

import { applyModule5PeerBandFluxFixes } from './fluxPeerBandFix';

/** Apply Flux sanitization to all query-like fields on a panel's targets. */
export function applyFluxFixesToPanel(
    panel: PanelRecord,
    options?: {
        aggressive?: boolean;
        dashboardTitle?: string;
        referenceTarget?: PanelRecord;
        referencePanel?: PanelRecord;
    }
): { panel: PanelRecord; changed: boolean; targetsFixed: number } {
    const peer = applyModule5PeerBandFluxFixes(panel, {
        force: options?.aggressive === true,
        dashboardTitle: options?.dashboardTitle,
        referenceTarget: options?.referenceTarget,
        referencePanel: options?.referencePanel,
    });
    if (peer.changed) {
        return peer;
    }

    const aggressive = options?.aggressive === true;
    const deep = deepSanitizeFluxStrings(panel, aggressive);
    const copy = deep.value as PanelRecord;

    let targetsFixed = 0;
    const targets = copy.targets;
    if (Array.isArray(targets)) {
        for (const t of targets) {
            if (t && typeof t === 'object' && fixTargetLikeObject(t as PanelRecord, aggressive)) {
                targetsFixed += 1;
            }
        }
    }
    const queries = copy.queries;
    if (Array.isArray(queries)) {
        for (const q of queries) {
            if (q && typeof q === 'object' && fixTargetLikeObject(q as PanelRecord, aggressive)) {
                targetsFixed += 1;
            }
        }
    }

    return {
        panel: copy,
        changed: deep.changed || targetsFixed > 0,
        targetsFixed: Math.max(targetsFixed, deep.changed ? 1 : 0),
    };
}

export function stampDashboardForOverwrite(
    baseline: Record<string, unknown>,
    dashboard: Record<string, unknown>
): Record<string, unknown> {
    const out = JSON.parse(JSON.stringify(dashboard)) as Record<string, unknown>;
    if (typeof baseline.version === 'number') {
        out.version = baseline.version;
    }
    if (typeof baseline.id === 'number') {
        out.id = baseline.id;
    }
    if (typeof baseline.uid === 'string') {
        out.uid = baseline.uid;
    }
    return out;
}
