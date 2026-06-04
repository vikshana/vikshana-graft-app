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
        out.expr = q;
        out.rawQuery = q;
        out.editorMode = 'code';
    } else if (out.rawQuery === true && typeof out.query === 'string') {
        const text = out.query as string;
        out.expr = text;
        out.rawQuery = text;
        out.editorMode = 'code';
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
        if (rec.uid && rec.type === 'influxdb') {
            out.datasource = { uid: rec.uid };
        }
    }

    for (const target of (out.targets as TargetRecord[]) ?? []) {
        const tds = target.datasource;
        if (tds && typeof tds === 'object' && !Array.isArray(tds)) {
            const rec = tds as Record<string, unknown>;
            if (rec.uid) {
                target.datasource = { uid: rec.uid };
            }
        }
    }

    return out;
}
