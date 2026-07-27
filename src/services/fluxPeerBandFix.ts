type PanelRecord = Record<string, unknown>;

export const DEFAULT_MEASUREMENT = 'machine_metrics';

export interface FluxFilterContext {
    bucketLine: string;
    rangeLine: string;
    machine: string;
    measurement: string;
    /** Only when target A already filtered on _measurement (PromQL name ≠ Influx tag). */
    useMeasurementFilter: boolean;
    peerFields: string[];
    module5Field: string;
    multilineFilter: boolean;
}

const WINDOW_LINE = '|> aggregateWindow(every: v.windowPeriod, fn: mean, createEmpty: false)';
/** Collapse tag cardinality per branch before windowing (avoids Grafana max series 1000). */
const COLLAPSE_LINE = '|> group()';

const DEFAULT_TARGET_LABELS: Record<string, string> = {
    A: 'Module 5 (Actual)',
    B: 'Peer Avg',
    C: 'Upper Band',
    D: 'Lower Band',
};

function escapeFluxString(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Flux legendFormat is ignored; map _field so Grafana + byName overrides match. */
function fluxSeriesLabelLine(label: string): string {
    const esc = escapeFluxString(label);
    return `|> map(fn: (r) => ({ _time: r._time, _value: r._value, _field: "${esc}" }))`;
}

function targetSeriesLabel(refId: string, legend: string): string {
    if (legend.trim()) {
        return legend.trim();
    }
    return DEFAULT_TARGET_LABELS[refId] ?? refId;
}

export const DEFAULT_PEER_MODULE_FIELDS = [
    'Module1_Current_A',
    'Module2_Current_A',
    'Module3_Current_A',
    'Module4_Current_A',
    'Module6_Current_A',
    'Module7_Current_A',
    'Module8_Current_A',
];

/** Substring shared by all anomaly peer-band panel titles on Exsolve dashboards. */
export const PEER_BAND_TITLE_MARKER = 'Peer Band (Modules 1–4,6–8 Avg ± 2σ)';

/** ML history panels stay on PromQL (PowerTech exporter); never Flux peer-band rewrite. */
export const HISTORY_COMPARISON_TITLE_MARKER = 'History Comparison';

const PEER_MODULE_NUMBERS = [1, 2, 3, 4, 6, 7, 8];

/** Module numbers used as peers — parsed from panel title, description, or PromQL. */
export function inferPeerModuleNumbersFromPanel(panel: PanelRecord): number[] | undefined {
    const blob = `${typeof panel.title === 'string' ? panel.title : ''} ${typeof panel.description === 'string' ? panel.description : ''}`;
    if (/Modules\s*1\s*[–\-—]\s*4\s*,\s*6\s*[–\-—]\s*8/i.test(blob)) {
        return [1, 2, 3, 4, 6, 7, 8];
    }
    if (/Modules\s*1\s*[–\-—]\s*7\b/i.test(blob)) {
        return [1, 2, 3, 4, 5, 6, 7];
    }
    const promRange = blob.match(/Module\[(\d+)-(\d+)\]/);
    if (promRange) {
        const lo = Number.parseInt(promRange[1], 10);
        const hi = Number.parseInt(promRange[2], 10);
        if (Number.isFinite(lo) && Number.isFinite(hi) && hi >= lo) {
            return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
        }
    }
    return undefined;
}

export function targetQueryText(target: PanelRecord): string {
    const query = typeof target.query === 'string' ? target.query : '';
    const expr = typeof target.expr === 'string' ? target.expr : '';
    const rawQuery = typeof target.rawQuery === 'string' ? target.rawQuery : '';
    if (/\bfrom\s*\(\s*bucket:/i.test(query)) {
        return query;
    }
    if (/\bfrom\s*\(\s*bucket:/i.test(expr)) {
        return expr;
    }
    if (/\bfrom\s*\(\s*bucket:/i.test(rawQuery)) {
        return rawQuery;
    }
    return query || expr || rawQuery;
}

export function isPromqlHistoryComparisonQuery(text: string): boolean {
    return (
        /machine_metric_(?:upper_bound|lower_bound|expected)\s*\{/.test(text) ||
        /last_over_time\s*\(\s*machine_metric_/i.test(text)
    );
}

export function isPromqlPeerBandQuery(text: string): boolean {
    if (isPromqlHistoryComparisonQuery(text)) {
        return false;
    }
    return /machine_metrics\s*\{/.test(text) && /Module\d+_/.test(text);
}

function parsePromqlTargetA(text: string): { machine: string; field: string } | null {
    const machine = text.match(/machine\s*=\s*"([^"]+)"/)?.[1];
    const field = text.match(/field\s*=\s*"([^"]+)"/)?.[1];
    if (!machine || !field || !/^Module\d+_/.test(field)) {
        return null;
    }
    return { machine, field };
}

function peerFieldsFromPromqlRegex(text: string, excludeField?: string): string[] | undefined {
    const m = text.match(/field\s*=~\s*"Module\[(\d+)-(\d+)\]_([^"]+)"/);
    if (!m) {
        return undefined;
    }
    const lo = Number.parseInt(m[1], 10);
    const hi = Number.parseInt(m[2], 10);
    const suffix = m[3];
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) {
        return undefined;
    }
    const out: string[] = [];
    for (let i = lo; i <= hi; i++) {
        const name = `Module${i}_${suffix}`;
        if (name !== excludeField) {
            out.push(name);
        }
    }
    return out.length > 0 ? out : undefined;
}

const FLUX_BUCKET_LINE = 'from(bucket: v.bucket)';
const FLUX_RANGE_LINE = '|> range(start: v.timeRangeStart, stop: v.timeRangeStop)';

function referenceTargetUsesFlux(reference?: PanelRecord): boolean {
    if (!reference) {
        return false;
    }
    return /\bfrom\s*\(\s*bucket:/i.test(targetQueryText(reference));
}

export function copyDatasourceFromReference(target: PanelRecord, reference?: PanelRecord): boolean {
    if (!reference?.datasource || typeof reference.datasource !== 'object') {
        return false;
    }
    if (!referenceTargetUsesFlux(reference)) {
        return false;
    }
    const nextDs = JSON.parse(JSON.stringify(reference.datasource));
    const current =
        target.datasource && typeof target.datasource === 'object'
            ? JSON.stringify(target.datasource)
            : '';
    if (current === JSON.stringify(nextDs)) {
        return false;
    }
    target.datasource = nextDs;
    return true;
}

export function applyPanelDatasourceFromReference(
    panel: PanelRecord,
    referencePanel?: PanelRecord,
    referenceTarget?: PanelRecord
): boolean {
    let changed = false;
    if (referencePanel?.datasource && typeof referencePanel.datasource === 'object') {
        panel.datasource = JSON.parse(JSON.stringify(referencePanel.datasource));
        changed = true;
    } else if (referenceTarget) {
        changed = copyDatasourceFromReference(panel, referenceTarget) || changed;
    }
    return changed;
}

export function getPanelTargetList(panel: PanelRecord): PanelRecord[] {
    const targets = panel.targets;
    if (Array.isArray(targets) && targets.length > 0) {
        return targets.filter((t) => t && typeof t === 'object') as PanelRecord[];
    }
    const queries = panel.queries;
    if (Array.isArray(queries) && queries.length > 0) {
        return queries.filter((q) => q && typeof q === 'object') as PanelRecord[];
    }
    return [];
}

export function setPanelTargetList(panel: PanelRecord, targetList: PanelRecord[]): void {
    if (Array.isArray(panel.targets) && panel.targets.length > 0) {
        panel.targets = targetList;
        return;
    }
    if (Array.isArray(panel.queries) && panel.queries.length > 0) {
        panel.queries = targetList;
        return;
    }
    panel.targets = targetList;
}

export function panelUsesPrometheusPeerBandQueries(panel: PanelRecord): boolean {
    if (isHistoryComparisonPanel(panel)) {
        return false;
    }
    return getPanelTargetList(panel).some((t) => isPromqlPeerBandQuery(targetQueryText(t)));
}

export interface ReferenceFluxPeerBandPanel {
    panel: PanelRecord;
    targetA: PanelRecord;
}

/** Working Flux peer-band panel (prefer Module 5) plus its target A. */
export function findReferenceFluxPeerBandPanel(panels: unknown[]): ReferenceFluxPeerBandPanel | undefined {
    if (!Array.isArray(panels)) {
        return undefined;
    }
    const entries = panels
        .filter((p) => p && typeof p === 'object')
        .map((p) => p as PanelRecord)
        .filter((p) => isPeerBandPanel(p));
    const sorted = [...entries].sort((a, b) => {
        const a5 = /module\s*5/i.test(String(a.title ?? '')) ? 0 : 1;
        const b5 = /module\s*5/i.test(String(b.title ?? '')) ? 0 : 1;
        return a5 - b5;
    });
    for (const panel of sorted) {
        for (const target of getPanelTargetList(panel)) {
            if (targetRefId(target) !== 'A') {
                continue;
            }
            if (/\bfrom\s*\(\s*bucket:/i.test(targetQueryText(target))) {
                return { panel, targetA: target };
            }
        }
    }
    return undefined;
}

/** @deprecated use findReferenceFluxPeerBandPanel */
export function findReferenceFluxPeerBandTargetA(panels: unknown[]): PanelRecord | undefined {
    return findReferenceFluxPeerBandPanel(panels)?.targetA;
}

/** Any dashboard panel that already runs Flux against Influx (peer band or other). */
export function findAnyFluxReferencePanel(panels: unknown[]): ReferenceFluxPeerBandPanel | undefined {
    const peer = findReferenceFluxPeerBandPanel(panels);
    if (peer) {
        return peer;
    }
    if (!Array.isArray(panels)) {
        return undefined;
    }
    for (const raw of panels) {
        if (!raw || typeof raw !== 'object') {
            continue;
        }
        const panel = raw as PanelRecord;
        for (const target of getPanelTargetList(panel)) {
            if (/\bfrom\s*\(\s*bucket:/i.test(targetQueryText(target))) {
                return { panel, targetA: target };
            }
        }
    }
    return undefined;
}

export function panelUsesFluxQueries(panel: PanelRecord): boolean {
    return getPanelTargetList(panel).some((t) => /\bfrom\s*\(\s*bucket:/i.test(targetQueryText(t)));
}

export function targetDatasourceType(target: PanelRecord): string {
    const ds = target.datasource;
    if (typeof ds === 'object' && ds !== null) {
        return String((ds as { type?: string }).type ?? '').toLowerCase();
    }
    return '';
}

export function panelFluxOnPrometheusDatasource(panel: PanelRecord): boolean {
    return getPanelTargetList(panel).some(
        (t) =>
            /\bfrom\s*\(\s*bucket:/i.test(targetQueryText(t)) &&
            (targetDatasourceType(t) === 'prometheus' || targetDatasourceType(t) === '')
    );
}

export function inferActualFieldFromPanelTitle(title: string): string | undefined {
    const m = title.match(/Module\s*(\d+)\s+(Current|Voltage)\b/i);
    if (!m) {
        return undefined;
    }
    return `Module${m[1]}_${m[2]}_A`;
}

export function inferActualDisplayLabel(panel: PanelRecord, actualField?: string): string {
    const title = typeof panel.title === 'string' ? panel.title : '';
    const fromTitle = title.match(/Module\s*(\d+)\s+(?:Current|Voltage)/i);
    if (fromTitle) {
        return `Module ${fromTitle[1]} (Actual)`;
    }
    const parsed = actualField?.match(/^Module(\d+)_/);
    if (parsed) {
        return `Module ${parsed[1]} (Actual)`;
    }
    return DEFAULT_TARGET_LABELS.A;
}

export function defaultPeerFieldsForActual(actualField: string, peerModuleNumbers?: number[]): string[] {
    const parsed = actualField.match(/^Module(\d+)_(.+)$/);
    if (!parsed) {
        return DEFAULT_PEER_MODULE_FIELDS;
    }
    const ownModule = Number.parseInt(parsed[1], 10);
    const suffix = parsed[2];
    const modules = peerModuleNumbers ?? PEER_MODULE_NUMBERS;
    return modules.filter((n) => n !== ownModule).map((n) => `Module${n}_${suffix}`);
}

export function panelTitleMatchesPeerBandMarker(title: string, titleContains = PEER_BAND_TITLE_MARKER): boolean {
    const normalizedTitle = title.trim().toLowerCase();
    const normalizedMarker = titleContains.trim().toLowerCase();
    return normalizedTitle.includes(normalizedMarker);
}

export function isHistoryComparisonPanel(panel: PanelRecord): boolean {
    const title = typeof panel.title === 'string' ? panel.title : '';
    const desc = typeof panel.description === 'string' ? panel.description : '';
    const titleMarker = HISTORY_COMPARISON_TITLE_MARKER.trim().toLowerCase();
    if (title.trim().toLowerCase().includes(titleMarker) || desc.trim().toLowerCase().includes(titleMarker)) {
        return true;
    }
    if (/\bhistory\s+band\b/i.test(title) || /\bhistory\s+band\b/i.test(desc)) {
        return true;
    }
    return getPanelTargetList(panel).some((t) => isPromqlHistoryComparisonQuery(targetQueryText(t)));
}

export function isPeerBandPanel(panel: PanelRecord, titleContains = PEER_BAND_TITLE_MARKER): boolean {
    if (isHistoryComparisonPanel(panel)) {
        return false;
    }
    const title = typeof panel.title === 'string' ? panel.title : '';
    const desc = typeof panel.description === 'string' ? panel.description : '';
    if (panelTitleMatchesPeerBandMarker(title, titleContains) || panelTitleMatchesPeerBandMarker(desc, titleContains)) {
        return true;
    }
    if (/module\s*\d+/i.test(title) && /peer|band|vs\./i.test(title)) {
        return true;
    }
    const blob = `${title} ${desc} ${JSON.stringify(panel.targets ?? [])}`;
    return /Module\d+_(?:Current|Voltage)_A/i.test(blob) && /\bunion\s*\(\s*tables\s*:/i.test(blob);
}

/** @deprecated use isPeerBandPanel */
export function isModule5PeerBandPanel(panel: PanelRecord): boolean {
    return isPeerBandPanel(panel);
}

function targetRefId(target: PanelRecord): string {
    return typeof target.refId === 'string' ? target.refId.trim() : '';
}

function targetLegend(target: PanelRecord): string {
    return typeof target.legendFormat === 'string' ? target.legendFormat : '';
}

function isTargetA(refId: string, legend: string): boolean {
    return refId === 'A' || /\(Actual\)/i.test(legend) || /module\s*\d+.*actual/i.test(legend);
}

function isPeerAvgTarget(refId: string, legend: string): boolean {
    return refId === 'B' || /peer\s*(avg|mean|average)/i.test(legend);
}

function isUpperBandTarget(refId: string, legend: string): boolean {
    return refId === 'C' || /upper\s+(?:peer\s+)?bound/i.test(legend) || /upper band/i.test(legend);
}

function isLowerBandTarget(refId: string, legend: string): boolean {
    return refId === 'D' || /lower\s+(?:peer\s+)?bound/i.test(legend) || /lower band/i.test(legend);
}

function collectPeerFieldNamesFromTargets(
    targets: unknown[],
    excludeField?: string,
    peerModuleNumbers?: number[]
): string[] {
    const found = new Set<string>();
    for (const t of targets) {
        if (!t || typeof t !== 'object') {
            continue;
        }
        const target = t as PanelRecord;
        const query = targetQueryText(target);
        if (!query) {
            continue;
        }
        for (const m of query.matchAll(/r\._field\s*==\s*"([^"]+)"/g)) {
            const name = m[1];
            if (
                name &&
                name !== excludeField &&
                /Module\d+_(?:Current|Voltage)_A/.test(name)
            ) {
                found.add(name);
            }
        }
        const fromProm = excludeField ? peerFieldsFromPromqlRegex(query, excludeField) : undefined;
        if (fromProm) {
            for (const name of fromProm) {
                found.add(name);
            }
        }
    }
    if (found.size >= 3) {
        return [...found].sort();
    }
    if (excludeField) {
        return defaultPeerFieldsForActual(excludeField, peerModuleNumbers);
    }
    return DEFAULT_PEER_MODULE_FIELDS;
}

function inferMachineFromDashboardTitle(title: string): string | undefined {
    const m = title.match(/([0-9]{4}-[0-9]+)/);
    return m?.[1];
}

function inferMeasurementFromPanel(panel: PanelRecord, targets: unknown[]): string {
    for (const t of targets) {
        if (!t || typeof t !== 'object') {
            continue;
        }
        const query = typeof (t as PanelRecord).query === 'string' ? String((t as PanelRecord).query) : '';
        const m = query.match(/r\._measurement\s*==\s*"([^"]+)"/)?.[1];
        if (m) {
            return m;
        }
    }
    const desc = typeof panel.description === 'string' ? panel.description : '';
    if (/machine_metrics/.test(desc)) {
        return DEFAULT_MEASUREMENT;
    }
    return DEFAULT_MEASUREMENT;
}

function unionBodyFromQuery(query: string): string {
    const start = query.match(/union\s*\(\s*tables\s*:\s*\[/i);
    if (!start || start.index == null) {
        return '';
    }
    const from = start.index + start[0].length;
    let depth = 1;
    for (let i = from; i < query.length; i++) {
        const ch = query[i];
        if (ch === '[') {
            depth += 1;
        } else if (ch === ']') {
            depth -= 1;
            if (depth === 0) {
                return query.slice(from, i);
            }
        }
    }
    return '';
}

/** Parse target A for bucket line, range, machine, module5 field name. */
export function parseTargetAQuery(query: string): {
    bucketLine: string;
    rangeLine: string;
    machine: string;
    module5Field: string;
    multilineFilter: boolean;
} | null {
    const bucketLine = query.match(/from\s*\(\s*bucket:\s*[^\)]+\)/i)?.[0]?.trim();
    const rangeLine = query.match(/\|\>\s*range\s*\([^\)]*\)/i)?.[0]?.trim();
    const machine = query.match(/r\.machine\s*==\s*"([^"]+)"/)?.[1];
    const module5Field = query.match(/r\._field\s*==\s*"([^"]+)"/)?.[1] ?? 'Module5_Current_A';
    if (!bucketLine || !rangeLine || !machine) {
        return null;
    }
    const multilineFilter = /\|\>\s*filter\s*\(\s*fn:\s*\(\s*r\s*\)\s*=>\s*\n/i.test(query);
    return { bucketLine, rangeLine, machine, module5Field, multilineFilter };
}

export function extractTargetABaseline(targets: unknown[], panel?: PanelRecord): FluxFilterContext | null {
    const peerModuleNumbers = panel ? inferPeerModuleNumbersFromPanel(panel) : undefined;
    for (const t of targets) {
        if (!t || typeof t !== 'object') {
            continue;
        }
        const target = t as PanelRecord;
        if (targetRefId(target) !== 'A') {
            continue;
        }
        const query = targetQueryText(target);
        if (isPromqlPeerBandQuery(query)) {
            const parsed = parsePromqlTargetA(query);
            if (!parsed) {
                continue;
            }
            return {
                bucketLine: FLUX_BUCKET_LINE,
                rangeLine: FLUX_RANGE_LINE,
                machine: parsed.machine,
                measurement: DEFAULT_MEASUREMENT,
                useMeasurementFilter: false,
                module5Field: parsed.field,
                multilineFilter: true,
                peerFields: collectPeerFieldNamesFromTargets(targets, parsed.field, peerModuleNumbers),
            };
        }
        if (!/\bfrom\s*\(\s*bucket:/i.test(query)) {
            continue;
        }
        const parsed = parseTargetAQuery(query);
        if (!parsed) {
            continue;
        }
        const measurement =
            query.match(/r\._measurement\s*==\s*"([^"]+)"/)?.[1] ??
            inferMeasurementFromPanel(panel ?? {}, targets);
        return {
            bucketLine: parsed.bucketLine,
            rangeLine: parsed.rangeLine,
            machine: parsed.machine,
            measurement,
            // PromQL machine_metrics ≠ Influx _measurement; prior fixes added a filter that returns no rows.
            useMeasurementFilter: false,
            module5Field: parsed.module5Field,
            multilineFilter: parsed.multilineFilter,
            peerFields: collectPeerFieldNamesFromTargets(targets, parsed.module5Field, peerModuleNumbers),
        };
    }
    return null;
}

export function inferFluxFilterContextFromTargets(
    targets: unknown[],
    options?: {
        dashboardTitle?: string;
        defaultBucket?: string;
        panel?: PanelRecord;
        referenceTarget?: PanelRecord;
    }
): FluxFilterContext | null {
    const fromA = extractTargetABaseline(targets, options?.panel);
    if (fromA) {
        return fromA;
    }

    let bucketLine: string | undefined;
    let machine: string | undefined;
    const panelTitle = typeof options?.panel?.title === 'string' ? options.panel.title : '';
    const peerModuleNumbers = options?.panel ? inferPeerModuleNumbersFromPanel(options.panel) : undefined;
    const inferredActual = inferActualFieldFromPanelTitle(panelTitle) ?? 'Module5_Current_A';
    const peerFields = collectPeerFieldNamesFromTargets(targets, inferredActual, peerModuleNumbers);

    for (const t of targets) {
        if (!t || typeof t !== 'object') {
            continue;
        }
        const target = t as PanelRecord;
        const query = targetQueryText(target);
        if (!query) {
            continue;
        }
        if (isPromqlPeerBandQuery(query)) {
            machine = machine ?? parsePromqlTargetA(query)?.machine;
        }
        bucketLine =
            bucketLine ??
            query.match(/from\s*\(\s*bucket:\s*[^\)]+\)/i)?.[0]?.trim() ??
            (query.match(/from\s*\(\s*bucket:\s*"([^"]+)"/)?.[1]
                ? `from(bucket: "${query.match(/from\s*\(\s*bucket:\s*"([^"]+)"/)?.[1]}")`
                : undefined);
        machine = machine ?? query.match(/r\.machine\s*==\s*"([^"]+)"/)?.[1];
    }

    if (options?.referenceTarget) {
        const refQuery = targetQueryText(options.referenceTarget);
        bucketLine =
            refQuery.match(/from\s*\(\s*bucket:\s*[^\)]+\)/i)?.[0]?.trim() ?? FLUX_BUCKET_LINE;
    }

    if (options?.dashboardTitle && !machine) {
        machine = inferMachineFromDashboardTitle(options.dashboardTitle);
    }
    if (!machine) {
        return null;
    }

    const defaultBucket = options?.defaultBucket ?? 'powertechdata';
    bucketLine = bucketLine ?? `from(bucket: "${defaultBucket}")`;
    return {
        bucketLine,
        rangeLine: FLUX_RANGE_LINE,
        machine,
        measurement: inferMeasurementFromPanel(options?.panel ?? {}, targets),
        useMeasurementFilter: false,
        peerFields,
        module5Field: inferredActual,
        multilineFilter: true,
    };
}

function multilineFilterBody(ctx: FluxFilterContext, field: string): string {
    const lines = [
        ctx.useMeasurementFilter ? `    r._measurement == "${ctx.measurement}" and` : '',
        `    r.machine == "${ctx.machine}" and`,
        `    r._field == "${field}"`,
    ].filter(Boolean);
    return lines.join('\n');
}

function inlineFilterExpr(ctx: FluxFilterContext, field: string): string {
    const parts = [
        ctx.useMeasurementFilter ? `r._measurement == "${ctx.measurement}"` : '',
        `r.machine == "${ctx.machine}"`,
        `r._field == "${field}"`,
    ].filter(Boolean);
    return parts.join(' and ');
}

/** Target A: drop bare mean() (kills _time); keep() collapses tag cardinality. */
export function fixTargetAQuery(query: string, module5Field = 'Module5_Current_A'): { query: string; changed: boolean } {
    if (!query.includes(module5Field) && !/Module5_Current_A/.test(query)) {
        return { query, changed: false };
    }

    let out = query;
    let changed = false;

    if (/\|\>\s*mean\s*\(\s*\)/i.test(out)) {
        out = out.replace(/\n\s*\|\>\s*mean\s*\(\s*\)\s*/gi, '\n');
        changed = true;
    }

    if (!/\|\>\s*keep\s*\(/i.test(out)) {
        const withKeep = out.replace(
            /(\|\>\s*filter\s*\(\s*fn:\s*\(\s*r\s*\)\s*=>[\s\S]*?\n\s*\))/i,
            '$1\n  |> keep(columns: ["_time", "_value"])'
        );
        if (withKeep !== out) {
            out = withKeep;
            changed = true;
        }
    }

    return { query: out.trimEnd(), changed };
}

/**
 * One branch per peer field: filter + group() + keep() before union.
 * OR in one filter or missing group() scans 1000+ tag combinations per field.
 */
function peerSingleFieldBranch(ctx: FluxFilterContext, field: string): string {
    if (ctx.multilineFilter) {
        return (
            `  ${ctx.bucketLine}\n` +
            `  ${ctx.rangeLine}\n` +
            `  |> filter(fn: (r) =>\n` +
            `${multilineFilterBody(ctx, field)}\n` +
            `  )\n` +
            `  ${COLLAPSE_LINE}\n` +
            `  |> keep(columns: ["_time", "_value"])\n` +
            `  ${WINDOW_LINE}`
        );
    }
    return (
        `  ${ctx.bucketLine}\n` +
        `  ${ctx.rangeLine}\n` +
        `  |> filter(fn: (r) => ${inlineFilterExpr(ctx, field)})\n` +
        `  ${COLLAPSE_LINE}\n` +
        `  |> keep(columns: ["_time", "_value"])\n` +
        `  ${WINDOW_LINE}`
    );
}

function peerCollapsedUnionPipeline(ctx: FluxFilterContext): string {
    const branches = ctx.peerFields.map((field) => peerSingleFieldBranch(ctx, field));
    return `union(tables: [\n${branches.join(',\n')}\n])`;
}

function targetAQuery(ctx: FluxFilterContext, label: string): string {
    const seriesLabel = fluxSeriesLabelLine(label);
    if (ctx.multilineFilter) {
        return (
            `${ctx.bucketLine}\n` +
            `  ${ctx.rangeLine}\n` +
            `  |> filter(fn: (r) =>\n` +
            `${multilineFilterBody(ctx, ctx.module5Field)}\n` +
            `  )\n` +
            `  ${COLLAPSE_LINE}\n` +
            `  |> keep(columns: ["_time", "_value"])\n` +
            `  ${WINDOW_LINE}\n` +
            `  ${seriesLabel}`
        );
    }
    return (
        `${ctx.bucketLine}\n` +
        `  ${ctx.rangeLine}\n` +
        `  |> filter(fn: (r) => ${inlineFilterExpr(ctx, ctx.module5Field)})\n` +
        `  ${COLLAPSE_LINE}\n` +
        `  |> keep(columns: ["_time", "_value"])\n` +
        `  ${WINDOW_LINE}\n` +
        `  ${seriesLabel}`
    );
}

/** Merge per-_time tables into one series table for Grafana time series panels. */
const GRAFANA_MERGE_LINE = '|> group()';

function peerUnionTail(aggregateLines: string, label: string): string {
    return (
        `\n  |> group(columns: ["_time"])\n` +
        `${aggregateLines}\n` +
        `  ${GRAFANA_MERGE_LINE}\n` +
        `  ${fluxSeriesLabelLine(label)}`
    );
}

function peerAvgQuery(ctx: FluxFilterContext, label: string): string {
    return `${peerCollapsedUnionPipeline(ctx)}${peerUnionTail('  |> mean(column: "_value")', label)}`;
}

function peerStatsBandQuery(ctx: FluxFilterContext, sign: '+' | '-', label: string): string {
    const op = sign === '+' ? '+' : '-';
    const statsBlock =
        `  |> reduce(\n` +
        `      identity: {t: time(v: 0), count: 0, sum: 0.0, sumSq: 0.0},\n` +
        `      fn: (r, accumulator) => ({\n` +
        `          t: r._time,\n` +
        `          count: accumulator.count + 1,\n` +
        `          sum: accumulator.sum + r._value,\n` +
        `          sumSq: accumulator.sumSq + r._value * r._value,\n` +
        `      }),\n` +
        `  )\n` +
        `  |> map(fn: (r) => {\n` +
        `      mean = if r.count > 0 then r.sum / float(v: r.count) else 0.0\n` +
        `      variance = if r.count <= 1 then 0.0 else (r.sumSq / float(v: r.count)) - mean * mean\n` +
        `      std = if variance < 0.0 then 0.0 else math.sqrt(x: variance)\n` +
        `      return {_time: r.t, _value: mean ${op} 2.0 * std}\n` +
        `  })`;
    return `import "math"\n\n${peerCollapsedUnionPipeline(ctx)}${peerUnionTail(statsBlock, label)}`;
}

function normalizeFluxQuery(query: string): string {
    return query.replace(/\s+/g, ' ').trim();
}

export function peerBandQueryUsesUnionTemplate(query: string): boolean {
    return /\bunion\s*\(\s*tables\s*:/i.test(query);
}

export function peerBandQueryUsesRegexFieldFilter(query: string): boolean {
    return /\br\._field\s*=~/.test(query);
}

export function peerBandQueryUsesKeepCollapse(query: string): boolean {
    return /\|\>\s*keep\s*\(\s*columns:\s*\[\s*"_time"\s*,\s*"_value"/i.test(query);
}

export function peerBandQueryUsesMeasurementFilter(query: string): boolean {
    return /\br\._measurement\s*==\s*"machine_metrics"/i.test(query);
}

/** Remove PromQL-style measurement filter that returns zero rows in Flux. */
export function stripFluxMachineMetricsMeasurement(query: string): string {
    let out = query;
    out = out.replace(
        /\n\s*r\._measurement\s*==\s*"machine_metrics"\s*and\s*/gi,
        '\n'
    );
    out = out.replace(/\br\._measurement\s*==\s*"machine_metrics"\s*and\s*/gi, '');
    out = out.replace(/\s*and\s*r\._measurement\s*==\s*"machine_metrics"/gi, '');
    out = out.replace(/\br\._measurement\s*==\s*"machine_metrics"/gi, '');
    return out.replace(/\(\s*\n\s*=>/g, '(r) =>').trimEnd();
}

export function peerBandQueryHasWindowAlignment(query: string): boolean {
    return /\|\>\s*aggregateWindow\s*\(\s*every:\s*v\.windowPeriod/i.test(query);
}

/** After union aggregate, merge per-_time tables into one Grafana series. */
export function peerBandQueryHasGrafanaSeriesMerge(query: string): boolean {
    if (!peerBandQueryUsesUnionTemplate(query)) {
        return false;
    }
    const afterUnion = query.replace(/^[\s\S]*?\]\s*/m, '');
    if (!/\|\>\s*group\s*\(\s*columns:\s*\[\s*"_time"\s*\]\s*\)/i.test(afterUnion)) {
        return false;
    }
    return /\|\>\s*group\s*\(\s*\)\s*\n\s*\|\>\s*map\s*\(\s*fn:\s*\(\s*r\s*\)\s*=>\s*\(\{\s*_time:\s*r\._time,\s*_value:\s*r\._value,\s*_field:/i.test(
        afterUnion
    );
}

/** @deprecated use peerBandQueryHasGrafanaSeriesMerge */
export function peerBandQueryHasPostUnionCollapse(query: string): boolean {
    return peerBandQueryHasGrafanaSeriesMerge(query);
}

export function peerBandQueryHasSeriesLabel(query: string, label: string): boolean {
    const escaped = escapeFluxString(label);
    return (
        query.includes(`_field: "${escaped}"`) &&
        (/\|\>\s*map\s*\(/i.test(query) || /\|\>\s*set\s*\(\s*key:\s*"_field"/i.test(query))
    );
}

const PEER_BAND_REF_IDS = ['A', 'B', 'C', 'D'] as const;

/** displayName by query refId — works when Flux strips labels and legend shows "value". */
export function applyModule5PeerBandFieldOverrides(panel: PanelRecord): {
    panel: PanelRecord;
    changed: boolean;
} {
    const copy = JSON.parse(JSON.stringify(panel)) as PanelRecord;
    const fieldConfig = (copy.fieldConfig ?? {}) as PanelRecord;
    const overrides = Array.isArray(fieldConfig.overrides)
        ? (fieldConfig.overrides as PanelRecord[]).slice()
        : [];

    const actualLabel = inferActualDisplayLabel(copy);
    const labels: { refId: string; label: string }[] = [];
    const targets = copy.targets;
    if (Array.isArray(targets)) {
        for (const t of targets) {
            if (!t || typeof t !== 'object') {
                continue;
            }
            const target = t as PanelRecord;
            const refId = targetRefId(target);
            if (!(refId in DEFAULT_TARGET_LABELS)) {
                continue;
            }
            const legend = targetLegend(target);
            labels.push({
                refId,
                label:
                    refId === 'A' && !legend.trim()
                        ? actualLabel
                        : targetSeriesLabel(refId, legend),
            });
        }
    }
    if (labels.length === 0) {
        labels.push(
            ...PEER_BAND_REF_IDS.map((refId) => ({
                refId,
                label: refId === 'A' ? actualLabel : DEFAULT_TARGET_LABELS[refId],
            }))
        );
    }

    let changed = false;
    for (const { refId, label } of labels) {
        let override = overrides.find((o) => {
            const matcher = o.matcher as PanelRecord | undefined;
            return matcher?.id === 'byFrameRefID' && matcher?.options === refId;
        });
        if (!override) {
            override = {
                matcher: { id: 'byFrameRefID', options: refId },
                properties: [],
            };
            overrides.push(override);
            changed = true;
        }
        const props = Array.isArray(override.properties)
            ? (override.properties as PanelRecord[]).slice()
            : [];
        const displayIdx = props.findIndex((p) => p.id === 'displayName');
        if (displayIdx < 0) {
            props.unshift({ id: 'displayName', value: label });
            override.properties = props;
            changed = true;
        } else if (props[displayIdx].value !== label) {
            props[displayIdx] = { ...props[displayIdx], value: label };
            override.properties = props;
            changed = true;
        }
    }

    if (changed) {
        fieldConfig.overrides = overrides;
        copy.fieldConfig = fieldConfig;
    }
    return { panel: copy, changed };
}

/** Build 60 OR filter — one read scans too many series before keep(). */
export function peerBandQueryUsesOrCombinedPeerFilter(query: string): boolean {
    if (peerBandQueryUsesUnionTemplate(query)) {
        return false;
    }
    const eqFields = (query.match(/r\._field\s*==\s*"Module\d+_(?:Current|Voltage)_A"/g) ?? []).length;
    return eqFields >= 2 && /\bor\b/i.test(query);
}

/** Union of one-field branches with group() + keep + aggregateWindow per branch (build 66). */
export function peerBandQueryUsesCollapsedPeerUnion(query: string): boolean {
    if (!peerBandQueryUsesUnionTemplate(query)) {
        return false;
    }
    const unionBody = unionBodyFromQuery(query);
    if (!unionBody) {
        return false;
    }
    if (
        /\|\>\s*group\s*\(\s*columns:\s*\[\s*"_time"\s*\]\s*\)/i.test(unionBody) ||
        /\|\>\s*mean\s*\(\s*\)\s*$/im.test(unionBody)
    ) {
        return false;
    }
    const fieldMatches = unionBody.match(/r\._field\s*==\s*"Module\d+_(?:Current|Voltage)_A"/g) ?? [];
    const branchCount = fieldMatches.length;
    const groupCount = (unionBody.match(/\|\>\s*group\s*\(\s*\)/gi) ?? []).length;
    return (
        branchCount >= 3 &&
        groupCount >= branchCount &&
        /\|\>\s*keep\s*\(/i.test(unionBody) &&
        /\|\>\s*aggregateWindow\b/i.test(unionBody)
    );
}

export function peerBandQueryHasStaleInlineBranchOps(query: string): boolean {
    if (peerBandQueryUsesOrCombinedPeerFilter(query) || peerBandQueryUsesMeasurementFilter(query)) {
        return true;
    }
    const unionBody = unionBodyFromQuery(query);
    if (!unionBody) {
        return /\|\>\s*mean\s*\(\s*\)\s*$/im.test(query);
    }
    const fieldMatches = unionBody.match(/r\._field\s*==\s*"Module\d+_(?:Current|Voltage)_A"/g) ?? [];
    const branchCount = fieldMatches.length;
    const groupCount = (unionBody.match(/\|\>\s*group\s*\(\s*\)/gi) ?? []).length;
    return (
        /\|\>\s*group\s*\(\s*columns:\s*\[\s*"_time"\s*\]\s*\)/i.test(unionBody) ||
        /\|\>\s*mean\s*\(\s*\)/i.test(unionBody) ||
        !/\|\>\s*aggregateWindow\b/i.test(unionBody) ||
        (branchCount >= 1 && groupCount < branchCount)
    );
}

export function peerBandQueryNeedsRewrite(query: string, refId: string, legend: string): boolean {
    const label = targetSeriesLabel(refId, legend);
    if (isTargetA(refId, legend)) {
        return (
            peerBandQueryUsesMeasurementFilter(query) ||
            /\|\>\s*mean\s*\(\s*\)/i.test(query) ||
            !peerBandQueryUsesKeepCollapse(query) ||
            !peerBandQueryHasWindowAlignment(query) ||
            !/\|\>\s*group\s*\(\s*\)/i.test(query) ||
            !peerBandQueryHasSeriesLabel(query, label)
        );
    }
    if (isPeerAvgTarget(refId, legend) || isUpperBandTarget(refId, legend) || isLowerBandTarget(refId, legend)) {
        return (
            peerBandQueryUsesRegexFieldFilter(query) ||
            peerBandQueryUsesMeasurementFilter(query) ||
            peerBandQueryUsesOrCombinedPeerFilter(query) ||
            !peerBandQueryUsesCollapsedPeerUnion(query) ||
            peerBandQueryHasStaleInlineBranchOps(query) ||
            !peerBandQueryHasGrafanaSeriesMerge(query) ||
            !peerBandQueryHasSeriesLabel(query, label)
        );
    }
    return false;
}

function assignTargetQuery(target: PanelRecord, query: string, label?: string): void {
    const cleaned = stripFluxMachineMetricsMeasurement(query);
    target.query = cleaned;
    target.expr = cleaned;
    target.rawQuery = cleaned;
    target.editorMode = 'code';
    if (label && (!target.legendFormat || !String(target.legendFormat).trim())) {
        target.legendFormat = label;
    }
    const model = target.model;
    if (model && typeof model === 'object' && !Array.isArray(model)) {
        const modelRec = model as PanelRecord;
        modelRec.query = cleaned;
        modelRec.expr = cleaned;
        modelRec.rawQuery = cleaned;
        modelRec.editorMode = 'code';
        if (label && (!modelRec.legendFormat || !String(modelRec.legendFormat).trim())) {
            modelRec.legendFormat = label;
        }
    }
}

export interface BuildPeerBandPanelArgs {
    machineId: string;
    moduleNumber: number;
    influxDatasourceUid: string;
    /** Explicit panel title (e.g. Alert Test Peer Band). */
    panelTitle?: string;
    /** Peer module numbers (defaults to all 1–8 except the target). */
    peerModules?: number[];
    labels?: {
        actual?: string;
        peerMean?: string;
        upper?: string;
        lower?: string;
    };
}

/**
 * Build a new Module N Current vs peer mean ± 2σ time series panel (Influx Flux).
 * Reuses the same union/mean/±2σ query templates as peer-band repair.
 */
export function buildPeerBandPanel(args: BuildPeerBandPanelArgs): PanelRecord {
    const moduleNumber = args.moduleNumber;
    const actualField = `Module${moduleNumber}_Current_A`;
    const peerModules =
        args.peerModules?.filter((n) => n !== moduleNumber && n >= 1 && n <= 8) ??
        PEER_MODULE_NUMBERS.filter((n) => n !== moduleNumber);
    const peerFields = defaultPeerFieldsForActual(actualField, peerModules);
    const machine = args.machineId.replace(/"/g, '\\"');
    const ctx: FluxFilterContext = {
        bucketLine: FLUX_BUCKET_LINE,
        rangeLine: FLUX_RANGE_LINE,
        machine,
        measurement: DEFAULT_MEASUREMENT,
        useMeasurementFilter: false,
        peerFields,
        module5Field: actualField,
        multilineFilter: true,
    };
    const actualLabel = args.labels?.actual?.trim() || `Module ${moduleNumber} (Actual)`;
    const peerMeanLabel = args.labels?.peerMean?.trim() || 'Peer Mean';
    const upperLabel = args.labels?.upper?.trim() || 'Upper Peer Bound (±2σ)';
    const lowerLabel = args.labels?.lower?.trim() || 'Lower Peer Bound (±2σ)';
    const title =
        args.panelTitle?.trim() ||
        `Module ${moduleNumber} Current — vs. Peer Band (Modules ${formatPeerModulesForTitle(peerModules)} Avg ± 2σ)`;
    const ds = { type: 'influxdb', uid: args.influxDatasourceUid };

    const panel: PanelRecord = {
        id: null,
        type: 'timeseries',
        title,
        description:
            `Module ${moduleNumber} actual vs peer modules [${peerModules.join(', ')}] mean ± **2σ** (Influx Flux). ` +
            'Upper/Lower Peer Bounds computed in Flux (not legend-only). Not RandomForest / not ml_predictions.',
        timezone: 'browser',
        datasource: ds,
        gridPos: { h: 12, w: 24, x: 0, y: 0 },
        fieldConfig: {
            defaults: {
                custom: { drawStyle: 'line', spanNulls: true, showPoints: 'never' },
                unit: 'amp',
            },
            overrides: [],
        },
        options: { legend: { displayMode: 'list', placement: 'bottom', showLegend: true } },
        targets: [
            {
                refId: 'A',
                datasource: ds,
                legendFormat: actualLabel,
                query: targetAQuery(ctx, actualLabel),
                rawQuery: true,
                editorMode: 'code',
            },
            {
                refId: 'B',
                datasource: ds,
                legendFormat: peerMeanLabel,
                query: peerAvgQuery(ctx, peerMeanLabel),
                rawQuery: true,
                editorMode: 'code',
            },
            {
                refId: 'C',
                datasource: ds,
                legendFormat: upperLabel,
                query: peerStatsBandQuery(ctx, '+', upperLabel),
                rawQuery: true,
                editorMode: 'code',
            },
            {
                refId: 'D',
                datasource: ds,
                legendFormat: lowerLabel,
                query: peerStatsBandQuery(ctx, '-', lowerLabel),
                rawQuery: true,
                editorMode: 'code',
            },
        ],
    };
    return applyModule5PeerBandFieldOverrides(panel).panel;
}

function formatPeerModulesForTitle(peerModules: number[]): string {
    if (
        peerModules.length === 7 &&
        peerModules.every((n, i) => n === [1, 2, 3, 4, 6, 7, 8][i])
    ) {
        return '1–4,6–8';
    }
    if (
        peerModules.length === 7 &&
        peerModules.every((n, i) => n === [1, 2, 3, 4, 5, 6, 7][i])
    ) {
        return '1–7';
    }
    return peerModules.join(',');
}

export function applyModule5PeerBandFluxFixes(
    panel: PanelRecord,
    options?: {
        force?: boolean;
        dashboardTitle?: string;
        referenceTarget?: PanelRecord;
        referencePanel?: PanelRecord;
    }
): {
    panel: PanelRecord;
    changed: boolean;
    targetsFixed: number;
} {
    if (isHistoryComparisonPanel(panel) || !isPeerBandPanel(panel)) {
        return { panel, changed: false, targetsFixed: 0 };
    }

    const copy = JSON.parse(JSON.stringify(panel)) as PanelRecord;
    const targetList = getPanelTargetList(copy);
    if (targetList.length === 0) {
        return { panel: copy, changed: false, targetsFixed: 0 };
    }

    const filterCtx = inferFluxFilterContextFromTargets(targetList, {
        dashboardTitle: options?.dashboardTitle,
        panel: copy,
        referenceTarget: options?.referenceTarget,
    });
    if (!filterCtx) {
        return { panel, changed: false, targetsFixed: 0 };
    }
    filterCtx.useMeasurementFilter = false;

    const actualLabel = inferActualDisplayLabel(copy, filterCtx.module5Field);
    let changed = false;
    let targetsFixed = 0;
    const convertingFromProm = panelUsesPrometheusPeerBandQueries(copy);

    if (convertingFromProm && options?.referenceTarget) {
        for (const target of targetList) {
            if (copyDatasourceFromReference(target, options.referenceTarget)) {
                changed = true;
            }
        }
        if (applyPanelDatasourceFromReference(copy, options.referencePanel, options.referenceTarget)) {
            changed = true;
        }
    }

    for (const target of targetList) {
        const refId = targetRefId(target);
        const legend = targetLegend(target);
        const query = targetQueryText(target);
        if (!query) {
            continue;
        }

        let nextQuery: string | undefined;
        const label =
            isTargetA(refId, legend) && !legend.trim()
                ? actualLabel
                : targetSeriesLabel(refId, legend);
        if (isTargetA(refId, legend)) {
            nextQuery = targetAQuery(filterCtx, label);
        } else if (isPeerAvgTarget(refId, legend)) {
            nextQuery = peerAvgQuery(filterCtx, label);
        } else if (isUpperBandTarget(refId, legend)) {
            nextQuery = peerStatsBandQuery(filterCtx, '+', label);
        } else if (isLowerBandTarget(refId, legend)) {
            nextQuery = peerStatsBandQuery(filterCtx, '-', label);
        }

        const isProm = isPromqlPeerBandQuery(query);
        const needsRewrite =
            options?.force ||
            isProm ||
            convertingFromProm ||
            (nextQuery != null &&
                (peerBandQueryNeedsRewrite(query, refId, legend) ||
                    normalizeFluxQuery(nextQuery) !== normalizeFluxQuery(query)));

        if (nextQuery && needsRewrite) {
            if (options?.referenceTarget && copyDatasourceFromReference(target, options.referenceTarget)) {
                changed = true;
            }
            assignTargetQuery(target, nextQuery, label);
            changed = true;
            targetsFixed += 1;
        }
    }

    setPanelTargetList(copy, targetList);

    const overrideResult = applyModule5PeerBandFieldOverrides(copy);
    if (overrideResult.changed) {
        Object.assign(copy, overrideResult.panel);
        changed = true;
    }

    if (convertingFromProm && targetsFixed < 4) {
        return { panel, changed: false, targetsFixed: 0 };
    }

    if (convertingFromProm && panelUsesPrometheusPeerBandQueries(copy)) {
        return { panel, changed: false, targetsFixed: 0 };
    }

    return { panel: copy, changed, targetsFixed };
}

export function panelPeerBandTargetsStillStale(panel: PanelRecord): boolean {
    if (isHistoryComparisonPanel(panel) || !isPeerBandPanel(panel)) {
        return false;
    }
    if (panelUsesPrometheusPeerBandQueries(panel)) {
        return true;
    }
    for (const target of getPanelTargetList(panel)) {
        const refId = targetRefId(target);
        const legend = targetLegend(target);
        const query = targetQueryText(target);
        if (!query) {
            continue;
        }
        if (isTargetA(refId, legend)) {
            const label = targetSeriesLabel(refId, legend);
            if (
                peerBandQueryUsesMeasurementFilter(query) ||
                /\|\>\s*mean\s*\(\s*\)/i.test(query) ||
                !peerBandQueryUsesKeepCollapse(query) ||
                !peerBandQueryHasWindowAlignment(query) ||
                !/\|\>\s*group\s*\(\s*\)/i.test(query) ||
                !peerBandQueryHasSeriesLabel(query, label)
            ) {
                return true;
            }
            continue;
        }
        if (isPeerAvgTarget(refId, legend) || isUpperBandTarget(refId, legend) || isLowerBandTarget(refId, legend)) {
            const label = targetSeriesLabel(refId, legend);
            if (
                !peerBandQueryUsesCollapsedPeerUnion(query) ||
                !peerBandQueryHasGrafanaSeriesMerge(query) ||
                !peerBandQueryHasSeriesLabel(query, label)
            ) {
                return true;
            }
        }
    }
    return false;
}

// Legacy export for tests
export function extractFluxFilterContext(query: string): {
    bucket: string;
    machine: string;
    fieldRegex: string;
    peerFields: string[];
} | null {
    const bucket = query.match(/from\s*\(\s*bucket:\s*"([^"]+)"/)?.[1];
    const machine = query.match(/r\.machine\s*==\s*"([^"]+)"/)?.[1];
    const fieldRegex = query.match(/r\._field\s*=~\s*(\/[^/\n]+\/[gimsuy]*)/)?.[1];
    if (!bucket || !machine || !fieldRegex) {
        return null;
    }
    return { bucket, machine, fieldRegex, peerFields: DEFAULT_PEER_MODULE_FIELDS };
}
