import type { GrafanaAlertCreateRequest } from './grafanaAlertParse';
import { getPanelTargetList, targetQueryText } from './fluxPeerBandFix';
import { stripFluxLegendSuffix } from './sanitizeInfluxFluxPanel';

type PanelRecord = Record<string, unknown>;

export interface AlertQueryRelativeTimeRange {
    from: number;
    to: number;
}

export interface ProvisionedAlertQuery {
    refId: string;
    queryType: string;
    relativeTimeRange: AlertQueryRelativeTimeRange;
    datasourceUid: string;
    model: Record<string, unknown>;
}

export interface ClassifiedBoundTargets {
    actual: PanelRecord;
    upper: PanelRecord;
    lower: PanelRecord;
    actualRefId: string;
    upperRefId: string;
    lowerRefId: string;
}

const EXPR_DS_UID = '__expr__';
/** Match working Keysight Module 1 alert — ±2σ bands use 1h windows and need ≥24h range. */
const DEFAULT_LOOKBACK_SEC = 86400;

/**
 * Rewrite panel Flux so Grafana Alerting gets a numeric time series frame.
 * Panel legends intentionally emit `_field` labels (long format); Reduce/Math then fail.
 * Keep Influx selection filters like `r._field == "Module2_Current_A"`, but never yield
 * `_field` as an output column — only `_time` + `_value`.
 */
export function makeFluxQueryAlertCompatible(query: string): string {
    let q = stripFluxLegendSuffix(query.trim());
    if (!q) {
        return q;
    }

    // Drop legend/label `_field` from object-literal maps (incl. mean±2σ band maps).
    q = q.replace(
        /map\s*\(\s*fn:\s*\(\s*r\s*\)\s*=>\s*\(\s*\{\s*_time:\s*r\._time\s*,\s*_value:\s*([^,}]+?)\s*,\s*_field:\s*"[^"]*"\s*\}\s*\)\s*\)/gi,
        (_m, valueExpr: string) => `map(fn: (r) => ({ _time: r._time, _value: ${valueExpr.trim()} }))`
    );
    // Drop `r with _field: "..."` style maps.
    q = q.replace(/\n?\s*\|>\s*map\s*\(\s*fn:\s*\(\s*r\s*\)\s*=>\s*\(\s*\{\s*r\s+with\s+_field:\s*"[^"]*"\s*\}\s*\)\s*\)/gi, '');
    q = q.replace(/\n?\s*\|>\s*set\s*\(\s*key:\s*"_field"\s*,\s*value:\s*"[^"]*"\s*\)/gi, '');
    // Any keep that still retains `_field` → time/value only.
    q = q.replace(
        /\|>\s*keep\s*\(\s*columns:\s*\[[^\]]*"_field"[^\]]*\]\s*\)/gi,
        '|> keep(columns: ["_time", "_value"])'
    );

    if (!/\|>\s*keep\s*\(\s*columns:\s*\[\s*"_time"\s*,\s*"_value"\s*\]\s*\)\s*$/i.test(q.trimEnd())) {
        q = `${q.trimEnd()}\n  |> keep(columns: ["_time", "_value"])`;
    }
    return q.trimEnd();
}

/** True when a Flux string still yields `_field` as an output/legend column (bad for alerts). */
export function fluxQueryEmitsFieldLabel(query: string): boolean {
    if (/\|>\s*keep\s*\(\s*columns:\s*\[[^\]]*"_field"/i.test(query)) {
        return true;
    }
    if (/map\s*\([^)]*_field:\s*"/i.test(query)) {
        return true;
    }
    if (/\|>\s*set\s*\(\s*key:\s*"_field"/i.test(query)) {
        return true;
    }
    if (/\{\s*r\s+with\s+_field:/i.test(query)) {
        return true;
    }
    return false;
}

function datasourceUidOf(value: unknown): string | undefined {
    if (value && typeof value === 'object' && 'uid' in (value as Record<string, unknown>)) {
        const uid = (value as { uid?: unknown }).uid;
        return typeof uid === 'string' && uid.trim() ? uid : undefined;
    }
    return typeof value === 'string' && value.trim() ? value : undefined;
}

function targetLabel(target: PanelRecord): string {
    const legend = typeof target.legendFormat === 'string' ? target.legendFormat : '';
    if (legend.trim()) {
        return legend;
    }
    const query = typeof target.query === 'string' ? target.query : '';
    const fieldMap = query.match(/_field:\s*"([^"]+)"/);
    return fieldMap?.[1] ?? '';
}

function scoreTargetRole(label: string, query: string): 'actual' | 'upper' | 'lower' | 'mean' | null {
    const blob = `${label}\n${query}`.toLowerCase();
    if (/\bupper\b/.test(blob) || /upper\s*bound/.test(blob)) {
        return 'upper';
    }
    if (/\blower\b/.test(blob) || /lower\s*bound/.test(blob)) {
        return 'lower';
    }
    if (/\bmean\b/.test(blob) || /historical\s+mean/.test(blob)) {
        return 'mean';
    }
    if (/\bactual\b/.test(blob)) {
        return 'actual';
    }
    return null;
}

/**
 * Pick Actual / Upper Bound / Lower Bound targets from an Own History (±2σ) panel.
 * Prefers legendFormat / Flux _field labels; falls back to A / C / D when those refIds exist.
 */
export function classifyActualUpperLowerTargets(panel: PanelRecord): ClassifiedBoundTargets | null {
    const targets = getPanelTargetList(panel);
    if (targets.length === 0) {
        return null;
    }

    let actual: PanelRecord | undefined;
    let upper: PanelRecord | undefined;
    let lower: PanelRecord | undefined;

    for (const target of targets) {
        const role = scoreTargetRole(
            targetLabel(target),
            typeof target.query === 'string' ? target.query : ''
        );
        if (role === 'actual' && !actual) {
            actual = target;
        } else if (role === 'upper' && !upper) {
            upper = target;
        } else if (role === 'lower' && !lower) {
            lower = target;
        }
    }

    const byRef = (ref: string) =>
        targets.find((t) => String(t.refId ?? '').toUpperCase() === ref);

    if (!actual) {
        actual = byRef('A');
    }
    if (!upper) {
        upper = byRef('C');
    }
    if (!lower) {
        lower = byRef('D');
    }

    if (!actual || !upper || !lower) {
        return null;
    }

    return {
        actual,
        upper,
        lower,
        actualRefId: String(actual.refId ?? 'A'),
        upperRefId: String(upper.refId ?? 'C'),
        lowerRefId: String(lower.refId ?? 'D'),
    };
}

function cloneTargetAsAlertQuery(
    target: PanelRecord,
    refId: string,
    panelDatasourceUid: string | undefined,
    lookbackSec: number
): ProvisionedAlertQuery | null {
    const dsUid =
        datasourceUidOf(target.datasource) ?? panelDatasourceUid ?? datasourceUidOf(target.datasourceUid);
    if (!dsUid) {
        return null;
    }

    const model: Record<string, unknown> = { ...target, refId };
    const originalQuery = targetQueryText(target);
    if (/\bfrom\s*\(\s*bucket:/i.test(originalQuery)) {
        const alertQuery = makeFluxQueryAlertCompatible(originalQuery);
        model.query = alertQuery;
        model.rawQuery = true;
        model.editorMode = 'code';
        // Panel legendFormat is useless once `_field` labels are stripped for alerting.
        delete model.legendFormat;
        if ('expr' in model) {
            delete model.expr;
        }
    } else if (typeof model.rawQuery !== 'boolean' && typeof model.query === 'string') {
        model.rawQuery = true;
    }
    delete model.datasource;
    model.datasource = { type: typeof target.type === 'string' ? target.type : 'influxdb', uid: dsUid };
    if (target.datasource && typeof target.datasource === 'object' && 'type' in (target.datasource as object)) {
        const t = (target.datasource as { type?: string }).type;
        if (t) {
            model.datasource = { type: t, uid: dsUid };
        }
    }

    return {
        refId,
        queryType: typeof target.queryType === 'string' ? target.queryType : '',
        relativeTimeRange: { from: lookbackSec, to: 0 },
        datasourceUid: dsUid,
        model,
    };
}

function reduceQuery(refId: string, expression: string, lookbackSec: number): ProvisionedAlertQuery {
    return {
        refId,
        queryType: '',
        // Working Module 1 alert keeps the same lookback on Reduce as the data queries.
        relativeTimeRange: { from: lookbackSec, to: 0 },
        datasourceUid: EXPR_DS_UID,
        model: {
            refId,
            type: 'reduce',
            datasource: { type: '__expr__', uid: EXPR_DS_UID },
            expression,
            reducer: 'last',
            // Do NOT replace missing with 0 — that falsifies Actual vs band comparisons.
            settings: {
                mode: '',
            },
            hide: false,
            intervalMs: 1000,
            maxDataPoints: 43200,
        },
    };
}

function mathQuery(refId: string, expression: string): ProvisionedAlertQuery {
    return {
        refId,
        queryType: '',
        relativeTimeRange: { from: 600, to: 0 },
        datasourceUid: EXPR_DS_UID,
        model: {
            refId,
            type: 'math',
            datasource: { type: '__expr__', uid: EXPR_DS_UID },
            expression,
            hide: false,
            intervalMs: 1000,
            maxDataPoints: 43200,
        },
    };
}

export interface BuiltBandBreachAlert {
    /** Data queries use A/C/D; reduces E/F/G; math H is the condition. */
    data: ProvisionedAlertQuery[];
    condition: string;
    mathExpression: string;
}

/**
 * Build Grafana-managed alert queries: Last(Actual) > Last(Upper) OR Last(Actual) < Last(Lower).
 */
export function buildBandBreachAlertQueries(
    panel: PanelRecord,
    options?: { lookbackSec?: number }
): BuiltBandBreachAlert | { error: string } {
    const classified = classifyActualUpperLowerTargets(panel);
    if (!classified) {
        return {
            error:
                'Could not find Actual, Upper Bound, and Lower Bound queries on the panel. ' +
                'Expected Own History ±2σ targets (or legends containing Actual / Upper / Lower).',
        };
    }

    const panelDs = datasourceUidOf(panel.datasource);
    const lookback = options?.lookbackSec ?? DEFAULT_LOOKBACK_SEC;
    const qA = cloneTargetAsAlertQuery(classified.actual, 'A', panelDs, lookback);
    const qC = cloneTargetAsAlertQuery(classified.upper, 'C', panelDs, lookback);
    const qD = cloneTargetAsAlertQuery(classified.lower, 'D', panelDs, lookback);
    if (!qA || !qC || !qD) {
        return { error: 'Panel queries are missing a datasource uid (Influx/Prometheus).' };
    }

    for (const q of [qA, qC, qD]) {
        const flux = typeof q.model.query === 'string' ? q.model.query : '';
        if (flux && fluxQueryEmitsFieldLabel(flux)) {
            return {
                error:
                    'Alert Flux still emits `_field` labels after rewrite. ' +
                    'Expected keep(columns: ["_time", "_value"]) only — please report this panel query to Graft.',
            };
        }
    }

    const mathExpression = '$E > $F || $E < $G';
    return {
        condition: 'H',
        mathExpression,
        data: [
            qA,
            qC,
            qD,
            reduceQuery('E', 'A', lookback),
            reduceQuery('F', 'C', lookback),
            reduceQuery('G', 'D', lookback),
            mathQuery('H', mathExpression),
        ],
    };
}

export function defaultAlertRuleTitle(panelTitle: string): string {
    const trimmed = panelTitle.trim();
    if (/outside/i.test(trimmed)) {
        return trimmed.slice(0, 190);
    }
    return `${trimmed} — outside ±2σ`.slice(0, 190);
}

export function defaultAlertRuleGroup(dashboardUid: string, panelId: number | string): string {
    return `graft-${dashboardUid}-${panelId}`.slice(0, 190);
}

/** Parse "1m" / "60s" into Grafana rule-group interval seconds. Defaults to 60. */
export function parseEvalIntervalSeconds(every?: string): number {
    if (!every) {
        return 60;
    }
    const m = every.trim().toLowerCase().match(/^(\d+)\s*([smhd])$/);
    if (!m) {
        return 60;
    }
    const n = Number(m[1]);
    const unit = m[2];
    if (unit === 's') {
        return Math.max(10, n);
    }
    if (unit === 'm') {
        return Math.max(10, n * 60);
    }
    if (unit === 'h') {
        return Math.max(10, n * 3600);
    }
    return Math.max(10, n * 86400);
}

/** Grafana Duration string for the pending `for` field. */
export function normalizePendingFor(pendingFor?: string): string {
    if (!pendingFor) {
        return '1m';
    }
    const cleaned = pendingFor.replace(/\s+/g, '').toLowerCase();
    return /^\d+[smhd]$/.test(cleaned) ? cleaned : '1m';
}

export function matchContactPointName(
    available: Array<{ name?: string }>,
    wanted: string
): string | null {
    const want = wanted.trim().toLowerCase();
    if (!want) {
        return null;
    }
    const exact = available.find((c) => (c.name ?? '').trim().toLowerCase() === want);
    if (exact?.name) {
        return exact.name;
    }
    const partial = available.find((c) => {
        const n = (c.name ?? '').trim().toLowerCase();
        return n.includes(want) || want.includes(n);
    });
    return partial?.name ?? null;
}

export function buildProvisionedAlertRuleBody(args: {
    request: GrafanaAlertCreateRequest;
    title: string;
    ruleGroup: string;
    folderUID: string;
    orgId: number;
    panelId: number;
    dashboardUid: string;
    data: ProvisionedAlertQuery[];
    condition: string;
    contactPointName?: string;
    /** When set, this body is for PUT update of an existing rule. */
    uid?: string;
}): Record<string, unknown> {
    const pending = normalizePendingFor(args.request.pendingFor);
    const body: Record<string, unknown> = {
        title: args.title,
        ruleGroup: args.ruleGroup,
        folderUID: args.folderUID,
        orgId: args.orgId,
        uid: args.uid ?? '',
        condition: args.condition,
        data: args.data,
        noDataState: 'NoData',
        // Match working Module 1 alert — evaluation errors should surface as Alerting so
        // operators still get notified rather than a silent Error state.
        execErrState: 'Alerting',
        for: pending,
        annotations: {
            summary: `${args.title}: Actual outside Own History ±2σ band`,
            __dashboardUid__: args.dashboardUid,
            __panelId__: String(args.panelId),
            graft_alert_format: 'numeric-time-value',
        },
        labels: {
            graft: 'true',
            graft_source: 'panel-alert-create',
        },
        isPaused: false,
    };
    if (args.contactPointName) {
        body.notification_settings = {
            receiver: args.contactPointName,
        };
    }
    return body;
}
