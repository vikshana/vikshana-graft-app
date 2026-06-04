import {
    applyPanelDatasourceFromReference,
    copyDatasourceFromReference,
    findAnyFluxReferencePanel,
    getPanelTargetList,
    panelUsesFluxQueries,
    targetDatasourceType,
    targetQueryText,
} from './fluxPeerBandFix';

type PanelRecord = Record<string, unknown>;
type TargetRecord = Record<string, unknown>;

function targetHasInfluxFluxText(target: TargetRecord): boolean {
    return /\bfrom\s*\(\s*bucket:/i.test(targetQueryText(target as PanelRecord));
}

const DEFAULT_FLUX_TARGET_LABELS: Record<string, string> = {
    A: 'Module 5 (Actual)',
    B: 'Upper Bound (RF)',
    C: 'Lower Bound (RF)',
    D: 'Expected (RF)',
};

function escapeFluxString(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Grafana ignores legendFormat for Flux; map _field so legend matches field overrides. */
function fluxMapFieldLabelLine(label: string): string {
    const esc = escapeFluxString(label.trim());
    return `|> map(fn: (r) => ({ _time: r._time, _value: r._value, _field: "${esc}" }))`;
}

function extractFluxSetFieldLabel(query: string): string | undefined {
    const m = query.match(/\|>\s*set\s*\(\s*key:\s*"_field"\s*,\s*value:\s*"([^"]+)"/i);
    return m?.[1]?.trim();
}

/** Replace set(_field) with map(_field) so legends show names, not _value {_start=...}. */
export function normalizeFluxSeriesLegendInTarget(target: TargetRecord): boolean {
    const q = targetQueryText(target as PanelRecord);
    if (!/\bfrom\s*\(\s*bucket:/i.test(q)) {
        return false;
    }

    const refId = typeof target.refId === 'string' ? target.refId.trim() : '';
    const label =
        extractFluxSetFieldLabel(q) ??
        (typeof target.legendFormat === 'string' && target.legendFormat.trim()
            ? target.legendFormat.trim()
            : undefined) ??
        (refId ? DEFAULT_FLUX_TARGET_LABELS[refId] : undefined);

    if (!label) {
        return false;
    }

    const mapLine = fluxMapFieldLabelLine(label);
    let next = q;
    let changed = false;

    if (/\|>\s*set\s*\(\s*key:\s*"_field"/i.test(next)) {
        next = next.replace(/\|>\s*set\s*\(\s*key:\s*"_field"\s*,\s*value:\s*"[^"]+"\s*\)\s*/gi, `${mapLine}\n`);
        changed = true;
    } else if (!/\|>\s*map\s*\(\s*fn:\s*\(\s*r\s*\)\s*=>\s*\(\s*\{\s*_time:/i.test(next)) {
        next = `${next.trim()}\n  ${mapLine}`;
        changed = true;
    }

    if (changed || target.query !== next) {
        target.query = next;
        target.rawQuery = true;
        target.editorMode = 'code';
        delete target.expr;
        target.legendFormat = label;
        return true;
    }

    if (!target.legendFormat) {
        target.legendFormat = label;
        return true;
    }

    return false;
}

/**
 * Influx Flux targets must use `query` + `rawQuery: true`. Flux in `expr` only (no `query`) causes
 * Grafana to send Flux as the PromQL `query` parameter → parse error unexpected identifier "v".
 */
export function normalizeInfluxFluxTarget(target: TargetRecord): TargetRecord {
    const out = { ...target };
    const q =
        typeof out.query === 'string'
            ? out.query
            : typeof out.expr === 'string'
              ? out.expr
              : typeof out.rawQuery === 'string'
                ? out.rawQuery
                : undefined;

    if (!q) {
        if (out.rawQuery === true && typeof out.query === 'string') {
            out.editorMode = 'code';
            delete out.expr;
        }
        return out;
    }

    const dsType = targetDatasourceType(out as PanelRecord);
    const isInfluxFlux =
        dsType.includes('influx') || targetHasInfluxFluxText(out) || out.rawQuery === true;

    if (isInfluxFlux && targetHasInfluxFluxText({ ...out, query: q } as TargetRecord)) {
        out.query = q;
        out.rawQuery = true;
        out.editorMode = 'code';
        delete out.expr;
        delete out.queryText;
        return out;
    }

    out.query = q;
    out.editorMode = 'code';
    if (dsType.includes('influx')) {
        out.rawQuery = true;
        delete out.expr;
    } else if (!out.expr || out.expr !== q) {
        out.expr = q;
    }

    return out;
}

/**
 * Panel JSON pasted from docs/fixtures must not set invalid panel time overrides or boolean rawQuery.
 */
export function sanitizeInfluxFluxPanel(panel: PanelRecord): PanelRecord {
    const out = JSON.parse(JSON.stringify(panel)) as PanelRecord;

    delete out.timeFrom;
    delete out.timeTo;

    if (Array.isArray(out.targets)) {
        out.targets = (out.targets as TargetRecord[]).map((t) => normalizeInfluxFluxTarget(t));
    }

    const ds = out.datasource;
    if (ds && typeof ds === 'object' && !Array.isArray(ds)) {
        const rec = ds as Record<string, unknown>;
        if (rec.uid) {
            out.datasource = JSON.parse(JSON.stringify(rec));
            if ((out.datasource as Record<string, unknown>).type === 'influxdb') {
                delete (out.datasource as Record<string, unknown>).type;
            }
        }
    }

    for (const target of getPanelTargetList(out)) {
        const tds = target.datasource;
        if (tds && typeof tds === 'object' && !Array.isArray(tds)) {
            const rec = { ...(tds as Record<string, unknown>) };
            if (rec.type === 'influxdb') {
                delete rec.type;
            }
            target.datasource = rec;
        }
    }

    return out;
}

export interface InfluxFluxPanelRepairResult {
    panel: PanelRecord;
    changed: boolean;
    fixes: string[];
}

/**
 * Flux on a Prometheus datasource causes PromQL parse errors (e.g. unexpected identifier "v").
 * Copy datasource from a working Flux panel on the same dashboard.
 */
export function repairInfluxFluxPanel(
    panel: PanelRecord,
    dashboardPanels?: unknown[]
): InfluxFluxPanelRepairResult {
    const fixes: string[] = [];
    const before = JSON.stringify(panel);
    let out = sanitizeInfluxFluxPanel(panel);

    if (!panelUsesFluxQueries(out)) {
        return { panel: out, changed: before !== JSON.stringify(out), fixes };
    }

    const ref = dashboardPanels ? findAnyFluxReferencePanel(dashboardPanels) : undefined;
    if (ref) {
        for (const target of getPanelTargetList(out)) {
            if (copyDatasourceFromReference(target, ref.targetA)) {
                fixes.push(`target ${String(target.refId ?? '?')}: datasource matched working Flux panel`);
            }
        }
        if (applyPanelDatasourceFromReference(out, ref.panel, ref.targetA)) {
            fixes.push('panel datasource matched working Flux panel');
        }
    }

    for (const target of getPanelTargetList(out)) {
        if (!targetHasInfluxFluxText(target)) {
            continue;
        }
        const beforeTarget = JSON.stringify(target);
        Object.assign(target, normalizeInfluxFluxTarget(target as TargetRecord));
        if (beforeTarget !== JSON.stringify(target)) {
            fixes.push(
                `target ${String(target.refId ?? '?')}: query + rawQuery:true; removed expr`
            );
        }
        if (normalizeFluxSeriesLegendInTarget(target)) {
            fixes.push(
                `target ${String(target.refId ?? '?')}: legend label via map(_field) (${String(target.legendFormat)})`
            );
        }
    }

    const changed = before !== JSON.stringify(out);
    if (panelUsesFluxQueries(out) && getPanelTargetList(out).some((t) => targetDatasourceType(t) === 'prometheus')) {
        fixes.push(
            'WARNING: Flux queries still on Prometheus datasource — set datasource to the same source as your working peer-band panel in Grafana'
        );
    }

    return { panel: out, changed, fixes };
}
