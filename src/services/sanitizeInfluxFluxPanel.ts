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
        const normalized = normalizeInfluxFluxTarget(target as TargetRecord);
        Object.assign(target, normalized);
        if (beforeTarget !== JSON.stringify(target)) {
            fixes.push(
                `target ${String(target.refId ?? '?')}: Flux moved to query + rawQuery:true; removed expr`
            );
        } else if (typeof target.expr === 'string') {
            delete target.expr;
            fixes.push(`target ${String(target.refId ?? '?')}: removed expr (Influx uses query only)`);
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
