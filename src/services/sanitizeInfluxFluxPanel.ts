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

/** Grafana ignores legendFormat for Flux; collapse to _time/_value/_field so legend is not _value {tags}. */
function fluxMapFieldLabelLine(label: string): string {
    const esc = escapeFluxString(label.trim());
    return (
        `|> map(fn: (r) => ({ r with _field: "${esc}" }))\n` +
        `  |> keep(columns: ["_time", "_value", "_field"])`
    );
}

function stripFluxLegendMapLines(query: string): string {
    return query.replace(/\|>\s*map\s*\(\s*fn:\s*\([^)]*\)\s*=>\s*\([^)]*\)\s*\)\s*/gi, '');
}

const FLUX_FIELD_KEEP = '|> keep(columns: ["_time", "_value", "_field"])';

/** Last keep() in the pipeline must retain _field or Grafana legends stay "_value". */
function fluxQueryHasFinalFieldKeep(query: string): boolean {
    const keeps = [...query.matchAll(/\|>\s*keep\s*\(\s*columns:\s*\[([^\]]+)\]/gi)];
    if (keeps.length === 0) {
        return false;
    }
    return /"_field"/.test(keeps[keeps.length - 1][1]);
}

function fluxQueryLabelsField(query: string): boolean {
    return (
        /\|>\s*set\s*\(\s*key:\s*"_field"/i.test(query) ||
        /\|>\s*map\s*\([^)]*_field\s*:/i.test(query)
    );
}

function extractFluxMapFieldLabel(query: string): string | undefined {
    const m = query.match(/_field:\s*"([^"]+)"/i);
    return m?.[1]?.trim();
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
        (typeof target.legendFormat === 'string' && target.legendFormat.trim()
            ? target.legendFormat.trim()
            : undefined) ??
        (refId ? DEFAULT_FLUX_TARGET_LABELS[refId] : undefined) ??
        extractFluxSetFieldLabel(q) ??
        extractFluxMapFieldLabel(q);

    if (!label) {
        return false;
    }

    const mapLine = fluxMapFieldLabelLine(label);
    let next = q;
    let changed = false;

    if (/\|>\s*set\s*\(\s*key:\s*"_field"/i.test(next)) {
        next = next.replace(/\|>\s*set\s*\(\s*key:\s*"_field"\s*,\s*value:\s*"[^"]+"\s*\)\s*/gi, `${mapLine}\n`);
        changed = true;
    } else if (/\|>\s*map\s*\(\s*fn:\s*\(\s*r\s*\)\s*=>\s*\(\s*\{\s*_time:/i.test(next)) {
        next = `${stripFluxLegendMapLines(next).trim()}\n  ${mapLine}`;
        changed = true;
    } else if (!/\|>\s*map\s*\([^)]*_field/i.test(next)) {
        next = `${next.trim()}\n  ${mapLine}`;
        changed = true;
    } else if (fluxQueryLabelsField(next) && !fluxQueryHasFinalFieldKeep(next)) {
        next = `${next.trim()}\n  ${FLUX_FIELD_KEEP}`;
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

type OverrideRecord = {
    matcher?: { id?: string; options?: string };
    properties?: Array<{ id?: string; value?: unknown }>;
};

/** Force legend text via byFrameRefID — works when Flux still labels series as _value {tags}. */
export function ensureFluxTargetLegendOverrides(panel: PanelRecord): boolean {
    const targets = getPanelTargetList(panel);
    if (targets.length === 0) {
        return false;
    }

    const fieldConfig =
        panel.fieldConfig && typeof panel.fieldConfig === 'object' && !Array.isArray(panel.fieldConfig)
            ? ({ ...(panel.fieldConfig as Record<string, unknown>) } as Record<string, unknown>)
            : { defaults: {} };
    const overrides: OverrideRecord[] = Array.isArray(fieldConfig.overrides)
        ? (fieldConfig.overrides as OverrideRecord[]).map((o) => ({
              matcher: o.matcher ? { ...o.matcher } : undefined,
              properties: Array.isArray(o.properties) ? o.properties.map((p) => ({ ...p })) : [],
          }))
        : [];

    let changed = false;
    for (const target of targets) {
        const refId = typeof target.refId === 'string' ? target.refId.trim() : '';
        if (!refId) {
            continue;
        }
        const label =
            (typeof target.legendFormat === 'string' && target.legendFormat.trim()
                ? target.legendFormat.trim()
                : undefined) ??
            extractFluxSetFieldLabel(targetQueryText(target)) ??
            DEFAULT_FLUX_TARGET_LABELS[refId];
        if (!label) {
            continue;
        }

        let entry = overrides.find(
            (o) => o.matcher?.id === 'byFrameRefID' && String(o.matcher?.options) === refId
        );
        if (!entry) {
            entry = { matcher: { id: 'byFrameRefID', options: refId }, properties: [] };
            overrides.push(entry);
            changed = true;
        }
        const props = entry.properties ?? (entry.properties = []);
        const displayIdx = props.findIndex((p) => p.id === 'displayName');
        if (displayIdx >= 0) {
            if (props[displayIdx].value !== label) {
                props[displayIdx].value = label;
                changed = true;
            }
        } else {
            props.push({ id: 'displayName', value: label });
            changed = true;
        }
    }

    if (changed) {
        fieldConfig.overrides = overrides;
        panel.fieldConfig = fieldConfig;
    }
    return changed;
}

function panelNeedsFluxLegendRepair(panel: PanelRecord): boolean {
    const title = typeof panel.title === 'string' ? panel.title : '';
    if (/randomforest/i.test(title)) {
        return true;
    }
    return getPanelTargetList(panel).some((t) => /\bml_predictions\b/i.test(targetQueryText(t)));
}

export function hasFrameRefIdLegendOverrides(panel: PanelRecord): boolean {
    const targets = getPanelTargetList(panel);
    if (targets.length === 0) {
        return false;
    }
    const fieldConfig = panel.fieldConfig as { overrides?: OverrideRecord[] } | undefined;
    const overrides = fieldConfig?.overrides ?? [];
    return targets.every((target) => {
        const refId = typeof target.refId === 'string' ? target.refId.trim() : '';
        if (!refId) {
            return false;
        }
        const label =
            (typeof target.legendFormat === 'string' && target.legendFormat.trim()) ||
            DEFAULT_FLUX_TARGET_LABELS[refId];
        if (!label) {
            return false;
        }
        const entry = overrides.find(
            (o) => o.matcher?.id === 'byFrameRefID' && String(o.matcher?.options) === refId
        );
        return Boolean(
            entry?.properties?.some((p) => p.id === 'displayName' && p.value === label)
        );
    });
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

    if (panelNeedsFluxLegendRepair(out) && ensureFluxTargetLegendOverrides(out)) {
        fixes.push('panel fieldConfig: displayName overrides by query refId (A–D)');
    }

    const changed = before !== JSON.stringify(out);
    if (panelUsesFluxQueries(out) && getPanelTargetList(out).some((t) => targetDatasourceType(t) === 'prometheus')) {
        fixes.push(
            'WARNING: Flux queries still on Prometheus datasource — set datasource to the same source as your working peer-band panel in Grafana'
        );
    }

    return { panel: out, changed, fixes };
}
