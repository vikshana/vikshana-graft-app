import type { GrafanaAlertCreateRequest } from './grafanaAlertParse';
import { getPanelTargetList } from './fluxPeerBandFix';

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

const EXPR_DS_UID = '-100';
const DEFAULT_LOOKBACK_SEC = 600;

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
    // Alert engine wants flat model fields; keep rawQuery as boolean for Influx.
    if (typeof model.rawQuery !== 'boolean' && typeof model.query === 'string') {
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

function reduceQuery(refId: string, expression: string): ProvisionedAlertQuery {
    return {
        refId,
        queryType: '',
        relativeTimeRange: { from: 0, to: 0 },
        datasourceUid: EXPR_DS_UID,
        model: {
            refId,
            type: 'reduce',
            datasource: { type: '__expr__', uid: EXPR_DS_UID },
            expression,
            reducer: 'last',
            settings: {
                mode: '',
                replaceWithValue: 0,
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
        relativeTimeRange: { from: 0, to: 0 },
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

    const mathExpression = '$E > $F || $E < $G';
    return {
        condition: 'H',
        mathExpression,
        data: [
            qA,
            qC,
            qD,
            reduceQuery('E', 'A'),
            reduceQuery('F', 'C'),
            reduceQuery('G', 'D'),
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
}): Record<string, unknown> {
    const pending = normalizePendingFor(args.request.pendingFor);
    const body: Record<string, unknown> = {
        title: args.title,
        ruleGroup: args.ruleGroup,
        folderUID: args.folderUID,
        orgId: args.orgId,
        uid: '',
        condition: args.condition,
        data: args.data,
        noDataState: 'OK',
        execErrState: 'Error',
        for: pending,
        annotations: {
            summary: `${args.title}: Actual outside Own History ±2σ band`,
            __dashboardUid__: args.dashboardUid,
            __panelId__: String(args.panelId),
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
