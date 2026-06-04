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

/** Grafana Influx Flux targets expect query/expr/rawQuery as the same string — not rawQuery: true. */
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

    if (q) {
        out.query = q;
        out.rawQuery = q;
        out.editorMode = 'code';
        const dsType = targetDatasourceType(out as PanelRecord);
        if (dsType.includes('influx')) {
            delete out.expr;
        } else if (!out.expr || out.expr !== q) {
            out.expr = q;
        }
    } else if (out.rawQuery === true && typeof out.query === 'string') {
        const text = out.query as string;
        out.rawQuery = text;
        out.editorMode = 'code';
        delete out.expr;
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
            const dsType = targetDatasourceType(target);
            const flux = targetQueryText(target);
            if (dsType.includes('influx') && flux) {
                target.query = flux;
                target.rawQuery = flux;
                delete target.expr;
            }
        }
        if (applyPanelDatasourceFromReference(out, ref.panel, ref.targetA)) {
            fixes.push('panel datasource matched working Flux panel');
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
