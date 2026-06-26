import { llm } from '@grafana/llm';
import type { ToolExecution } from '../../types/llm.types';
import type {
    PlanStep, SpecialistResult, DataFindings, ToolCategory,
    ValidatedLokiQuery, ValidatedPrometheusQuery, DashboardSchemaCapability,
    PanelThreshold,
} from './types';
import { TOOL_CATEGORIES } from '../toolFilter';
import { normalizeToolArgs } from '../toolUtils';
import { enrichDataFindings } from './dashboardEnrichment';

/** findLastIndex polyfill — Array.prototype.findLastIndex requires ES2023 */
function findLastIndex<T>(arr: T[], predicate: (item: T) => boolean): number {
    for (let i = arr.length - 1; i >= 0; i--) {
        if (predicate(arr[i])) { return i; }
    }
    return -1;
}

// ─── Dashboard-tool result unwrapping ────────────────────────────────────────

/**
 * Unwraps the MCP double-envelope to get the actual JSON payload.
 *
 * MCP tool results arrive as:
 *   result.content = [{ type: 'text', text: '<JSON-stringified payload>' }]
 * The repo stringifies that array: rawResult = JSON.stringify(result.content)
 * So the parse chain is: JSON.parse(rawResult) → [0].text → JSON.parse(text) → struct
 *
 * Returns undefined if the content cannot be parsed.
 */
function unwrapMcpResult(rawResult: string): any {
    try {
        const outer = JSON.parse(rawResult);
        const textBlock = Array.isArray(outer) ? outer[0] : outer;
        const text = textBlock?.text ?? textBlock?.content ?? rawResult;
        if (typeof text === 'string') {
            try { return JSON.parse(text); } catch { return text; }
        }
        return text;
    } catch {
        return undefined;
    }
}

// ─── Tool scoping ─────────────────────────────────────────────────────────────

const DASHBOARD_TOOL_CATEGORIES = ['dashboards', 'datasources'];

function scopeDashboardTools(allTools: any[]): any[] {
    const allowed = new Set<string>();
    for (const cat of DASHBOARD_TOOL_CATEGORIES) {
        const catKey = cat as keyof typeof TOOL_CATEGORIES;
        if (TOOL_CATEGORIES[catKey]) {
            for (const tool of TOOL_CATEGORIES[catKey]) { allowed.add(tool); }
        }
    }
    return allTools.filter(t => allowed.has(t.function?.name));
}

// ─── Tools that must never be compressed (dashboard JSON is load-bearing) ────

const NO_COMPRESS = new Set([
    'get_dashboard_by_uid',
    'get_dashboard_panel_queries',
    'get_dashboard_property',
    'get_dashboard_summary',
    'update_dashboard',
]);

// ─── Result-envelope helpers ─────────────────────────────────────────────────

/** Extract the dashboard UID from an update_dashboard raw result. */
function extractDashboardUid(rawResult: string): string | undefined {
    try {
        const payload = unwrapMcpResult(rawResult);
        if (payload && typeof payload === 'object') {
            if (typeof payload.uid === 'string' && payload.uid) { return payload.uid; }
        }
    } catch { /* not parseable */ }
    return undefined;
}

/**
 * Reads isV2/apiVersion from a get_dashboard_by_uid tool result.
 * On mcp-grafana < v0.16.0 (current bundled v0.11.4) this key is absent → v1.
 */
function resolveSchemaFromProbeResult(
    rawResult: string,
    heuristic: DashboardSchemaCapability,
): DashboardSchemaCapability {
    try {
        const payload = unwrapMcpResult(rawResult);
        if (payload && typeof payload === 'object' && typeof payload.isV2 === 'boolean') {
            return heuristic === 'v2-capable' ? 'v2-capable' : 'v1';
        }
    } catch { /* not parseable */ }
    return 'v1';
}

// ─── DashboardSummary / PanelQuery shapes (from mcp-grafana v0.11.4 Go structs) ─

interface PanelSummary {
    id: number;
    title: string;
    type: string;
    description?: string;
    queryCount: number;
}

interface DashboardSummaryResult {
    uid: string;
    title: string;
    panelCount: number;
    panels: PanelSummary[];
    variables?: Array<{ name: string; type: string; label?: string }>;
    timeRange?: { from: string; to: string };
}

interface PanelQueryResult {
    title: string;
    query: string;
    datasource: { uid: string; type: string };
    refId?: string;
}

// ─── Completeness assessment ─────────────────────────────────────────────────

export interface DashboardGaps {
    /** Dashboard has zero data panels (the empty-skeleton regression) */
    emptyDashboard: boolean;
    /** Planned panel titles that are absent from the live dashboard */
    missingPanels: string[];
    /** Panels with LogQL on a prometheus datasource, or PromQL on a loki datasource */
    datasourceMismatches: Array<{ title: string; query: string; datasourceType: string }>;
    /** Data panels missing a description */
    panelsWithoutDescription: string[];
    /** Total data panel count in the live dashboard */
    livePanelCount: number;
}

const LOGQL_PATTERN = /\{[^}]*\}/;   // stream selector → Loki
const PROMQL_PATTERN = /\brate\s*\(|\bsum\s*\(|\bavg\s*\(|\bhistogram_quantile\s*\(|\b[a-z_]+_total\b|\b[a-z_]+_count\b/i;

function isLogQL(query: string): boolean { return LOGQL_PATTERN.test(query); }
function isPromQL(query: string): boolean {
    return PROMQL_PATTERN.test(query) && !isLogQL(query);
}

/**
 * Assesses the completeness of a live dashboard against the planned panel titles.
 * Uses get_dashboard_summary and get_dashboard_panel_queries result payloads
 * (already unwrapped from the MCP envelope by the caller).
 */
export function assessDashboardCompleteness(
    summary: DashboardSummaryResult | undefined,
    panelQueries: PanelQueryResult[] | undefined,
    plannedPanelTitles: string[],
): DashboardGaps {
    const gaps: DashboardGaps = {
        emptyDashboard: true,
        missingPanels: [],
        datasourceMismatches: [],
        panelsWithoutDescription: [],
        livePanelCount: 0,
    };

    if (!summary) { return gaps; }

    // Exclude row panels from the data-panel count
    // summary.panels can be null when the dashboard has no panels yet (mcp-grafana returns null not [])
    const dataPanels = (summary.panels ?? []).filter(p => p.type !== 'row');
    gaps.livePanelCount = dataPanels.length;
    gaps.emptyDashboard = dataPanels.length === 0;

    // Missing planned panels (normalised title match)
    const normTitle = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();
    const liveTitles = new Set(dataPanels.map(p => normTitle(p.title)));
    for (const planned of plannedPanelTitles) {
        if (!liveTitles.has(normTitle(planned))) {
            gaps.missingPanels.push(planned);
        }
    }

    // Panels missing description
    for (const p of dataPanels) {
        if (!p.description) { gaps.panelsWithoutDescription.push(p.title); }
    }

    // Datasource-type mismatches (from panel queries)
    if (panelQueries) {
        for (const pq of panelQueries) {
            const dsType = pq.datasource?.type?.toLowerCase() ?? '';
            const q = pq.query ?? '';
            if (dsType === 'prometheus' && isLogQL(q)) {
                gaps.datasourceMismatches.push({ title: pq.title, query: q, datasourceType: dsType });
            } else if (dsType === 'loki' && isPromQL(q)) {
                gaps.datasourceMismatches.push({ title: pq.title, query: q, datasourceType: dsType });
            }
        }
    }

    return gaps;
}

// ─── Findings formatter ───────────────────────────────────────────────────────

function renderThresholds(thresholds: PanelThreshold[]): string {
    return JSON.stringify(thresholds.map(t => ({ value: t.value, color: t.color })));
}

function formatFindingsForPrompt(dataFindings: DataFindings): string {
    const sections: string[] = [];

    if (dataFindings.loki) {
        const f = dataFindings.loki;
        const dsJson = `{"type": "loki", "uid": "${f.datasourceUid}"}`;
        const labelsBlock = Object.keys(f.labels ?? {}).length > 0
            ? `\nDiscovered labels (use for template variables):\n` +
              Object.entries(f.labels).map(([k, vs]) => `  ${k}: ${vs.slice(0, 5).join(', ')}`).join('\n')
            : '';
        sections.push(`## Loki Data Source
Datasource UID: ${f.datasourceUid}
Datasource name: ${f.datasourceName}
Datasource JSON (copy exactly into every Loki panel target): ${dsJson}
${labelsBlock}
Validated queries — copy BOTH expr AND datasource JSON into each panel target:
${f.validatedQueries.map((q: ValidatedLokiQuery, i) => {
    const meta: string[] = [];
    if (q.suggestedViz) { meta.push(`suggestedViz: ${q.suggestedViz}`); }
    if (q.unit) { meta.push(`unit: ${q.unit}`); }
    return `${i + 1}. Description: ${q.description}
   LogQL expr: ${q.logql}
   Datasource JSON: ${dsJson}${meta.length > 0 ? `\n   Presentation: ${meta.join(', ')}` : ''}`;
}).join('\n')}`);
    }

    if (dataFindings.prometheus) {
        const f = dataFindings.prometheus;
        const dsJson = `{"type": "prometheus", "uid": "${f.datasourceUid}"}`;
        const labelsBlock = Object.keys(f.labels ?? {}).length > 0
            ? `\nDiscovered labels (use for template variables):\n` +
              Object.entries(f.labels).map(([k, vs]) => `  ${k}: ${vs.slice(0, 5).join(', ')}`).join('\n')
            : '';
        sections.push(`## Prometheus Data Source
Datasource UID: ${f.datasourceUid}
Datasource name: ${f.datasourceName}
Datasource JSON (copy exactly into every Prometheus panel target): ${dsJson}
${labelsBlock}
Validated queries — copy BOTH expr AND datasource JSON into each panel target:
${f.validatedQueries.map((q: ValidatedPrometheusQuery, i) => {
    const meta: string[] = [];
    if (q.suggestedViz) { meta.push(`suggestedViz: ${q.suggestedViz}`); }
    if (q.unit) { meta.push(`unit: ${q.unit}`); }
    if (q.metricType) { meta.push(`metricType: ${q.metricType}`); }
    if (q.thresholds) { meta.push(`thresholds: ${renderThresholds(q.thresholds)}`); }
    return `${i + 1}. Description: ${q.description}
   PromQL expr: ${q.promql}
   Datasource JSON: ${dsJson}${meta.length > 0 ? `\n   Presentation: ${meta.join(', ')}` : ''}`;
}).join('\n')}`);
    }

    return sections.join('\n\n');
}

// ─── Empty-findings guidance ──────────────────────────────────────────────────

function buildEmptyFindingsGuidance(preferredCategories: ToolCategory[]): string {
    const onlyPrometheus = preferredCategories.length === 1 && preferredCategories[0] === 'prometheus';
    const onlyLoki = preferredCategories.length === 1 && preferredCategories[0] === 'loki';
    let datasourceDirective: string;
    if (onlyPrometheus) {
        datasourceDirective = `IMPORTANT — this dashboard needs **Prometheus metrics**. You MUST:
1. Call list_datasources and select a datasource of type **"prometheus"**.
2. Write **PromQL** expressions (metric names, rate(), sum(), histogram_quantile(), etc.).
3. Do NOT use a Loki datasource — this is a metrics dashboard.`;
    } else if (onlyLoki) {
        datasourceDirective = `IMPORTANT — this dashboard needs **Loki logs**. You MUST:
1. Call list_datasources and select a datasource of type **"loki"**.
2. Write **LogQL** expressions ({} stream selectors, |= filters, log_range_vector).
3. Do NOT use a Prometheus datasource — this is a logs dashboard.`;
    } else {
        datasourceDirective = `Select the datasource by TYPE:
   - Log panels / LogQL ({} stream selectors) → a datasource of type "loki".
   - Metric panels / PromQL (rate(), sum(), metric names) → a datasource of type "prometheus".`;
    }
    return `## No pre-validated queries were provided

You have NO pre-validated queries from upstream agents. You MUST discover the correct datasource
yourself before writing any panel. Call list_datasources first.

${datasourceDirective}

NEVER attach a LogQL query to a prometheus datasource, or a PromQL query to a loki datasource.`;
}

// ─── V1 panel quality rules ───────────────────────────────────────────────────

function buildV1PanelRules(layoutHint?: string): string {
    const rowStrategy = layoutHint === 'RED'
        ? `Group panels into rows: "Request Rate", "Errors", "Duration / Latency", and "Logs" (if applicable).`
        : layoutHint === 'USE'
        ? `Group panels into rows by resource: one row per resource type (CPU, Memory, Network, Disk).`
        : layoutHint === 'golden-signals'
        ? `Group panels into rows: "Latency", "Traffic", "Errors", "Saturation".`
        : `Group related panels into rows. One row per logical service, component, or signal type.`;

    return `## Panel construction rules

### Row panels (one per logical group, BEFORE its data panels)
{ "type": "row", "title": "<Row Title>", "id": <id>, "collapsed": false,
  "gridPos": { "h": 1, "w": 24, "x": 0, "y": <y> }, "panels": [] }

### Layout grouping
${rowStrategy}

### Panel layout (24-column grid)
- Stats row at top: w:6, h:4 per panel (4 across)
- Log panels: w:24, h:8 (full width)
- Paired panels (rate + errors): w:12, h:8 each at x:0 and x:12
- Single timeseries: w:24, h:8 or w:12 paired
- Always increment y; never overlap

### Visualization type (use suggestedViz from findings, else)
- "timeseries" — time-varying metrics (rates, counts over time)
- "stat" — single current values (uptime, version, current error count)
- "gauge" — bounded ratios/percentages (0–1 or 0–100)
- "bargauge" — comparing values across labels
- "heatmap" — histogram _bucket metrics (set dataFormat:"tsbuckets", use "le" legend)
- "table" — multi-column label breakdowns
- "logs" — raw Loki log streams (set options.dedupStrategy="none", options.showTime=true)
- "timeseries" — LogQL metric queries (rate(), count_over_time(), etc.)

### Units (fieldConfig.defaults.unit) — REQUIRED on every data panel
Use "unit" from presentation metadata. If not provided:
- "s" for _seconds/_duration, "ms" for _milliseconds, "ns" for _nanoseconds
- "bytes" for _bytes, "Bps" for bytes-per-second
- "percentunit" for 0–1 ratios, "percent" for 0–100
- "reqps" for rate() on _total/_count metrics
- "short" for dimensionless counts

### Thresholds — REQUIRED for stat, gauge, bargauge panels
Use "thresholds" from presentation metadata if provided. Default:
"fieldConfig": { "defaults": { "thresholds": {
  "mode": "absolute",
  "steps": [{"value": null, "color": "green"}, {"value": 80, "color": "orange"}, {"value": 90, "color": "red"}]
}, "color": { "mode": "thresholds" } } }

### Description — REQUIRED on every panel
"description": "<what this panel shows and why it matters>"

### Legend format — REQUIRED on every target
- Loki: use label matchers, e.g. "{{job}} {{level}}". Static string if no labels.
- Prometheus: use label names, e.g. "{{job}}" or "{{instance}}". Static if scalar.
- Never omit legendFormat. Never use "" or "{{__name__}}".

### Datasource correctness — CRITICAL
LogQL → loki datasource only. PromQL → prometheus datasource only. Never cross them.`;
}

// ─── V2 rules (dormant — requires mcp-grafana ≥ v0.16.0) ─────────────────────

function buildV2Rules(layoutHint?: string): string {
    const tabStrategy = layoutHint === 'RED'
        ? `Create tabs: "Request Rate", "Errors", "Duration", and (if applicable) "Logs".`
        : layoutHint === 'USE'
        ? `Create one tab per resource type (CPU, Memory, Network, Disk).`
        : layoutHint === 'golden-signals'
        ? `Create tabs: "Latency", "Traffic", "Errors", "Saturation".`
        : `Create one tab per logical service or signal type.`;

    return `## Dashboard schema: V2 (elements/layout/variables)
NOTE: This Grafana supports the V2 schema. If update_dashboard fails with
"Kubernetes-capable Grafana is required", fall back to Classic v1 immediately.

## V2 elements map, TabsLayout, variables[] — then full panels in one call.
${tabStrategy}
Apply the same unit/threshold/description/legend rules as v1 (see panel rules above).`;
}

// ─── Phase-specific system prompts ───────────────────────────────────────────

/**
 * PLAN phase: the LLM reads the enriched findings + user request and outputs
 * a JSON panel todo list. This list becomes the completeness contract for VERIFY.
 */
function buildPlanPhasePrompt(
    dataFindings: DataFindings,
    userMessage: string,
    context: string,
    conversationDigest: string,
    preferredCategories: ToolCategory[],
): string {
    const findingsBlock = formatFindingsForPrompt(dataFindings);
    const hasValidatedQueries =
        (dataFindings.loki?.validatedQueries?.length ?? 0) > 0 ||
        (dataFindings.prometheus?.validatedQueries?.length ?? 0) > 0;
    const hasKnownDatasource = findingsBlock.length > 0 && !hasValidatedQueries;

    // Build the available metrics block — injected when validatedQueries is empty
    // so the LLM plans from the real metric list, not from naming conventions.
    const availableMetricsList = (!hasValidatedQueries && dataFindings.prometheus?.availableMetrics?.length)
        ? `\n## Available metrics in this Prometheus datasource (${dataFindings.prometheus.availableMetrics.length} total)\nUse ONLY these metric names — do not invent names that are not on this list:\n${dataFindings.prometheus.availableMetrics.map(m => `  - ${m}`).join('\n')}`
        : '';

    return `You are a dashboard planning agent for Graft, an AI assistant embedded in Grafana.
Your task: analyse the user request and the pre-validated query findings below, then output a
STRUCTURED PANEL TODO LIST that the dashboard construction agent will use as its contract.

${conversationDigest ? `## Recent conversation\n${conversationDigest}\n\n` : ''}\
${hasValidatedQueries ? `## Pre-validated queries\n${findingsBlock}` :
  hasKnownDatasource ? `## Datasource identified\n${findingsBlock}\n\n${buildEmptyFindingsGuidance(preferredCategories)}` :
  buildEmptyFindingsGuidance(preferredCategories)}
${availableMetricsList}

${context ? `## Current Grafana context\n${context}` : ''}

## Output format (REQUIRED — output ONLY this JSON, no prose, no fences)
{
  "title": "<3-6 word dashboard name derived from the datasource and metric domain — e.g. 'OTel Receiver Metrics', 'API Error Rate', 'Kubernetes Node Health'>",
  "description": "<1-2 sentence description of what this dashboard monitors and why>",
  "panels": [
    {
      "title": "<panel title>",
      "description": "<what this panel shows and why it matters>",
      "query": "<EXACT PromQL/LogQL from findings, OR a PromQL expression using ONLY metric names from the available metrics list above>",
      "datasourceType": "<prometheus|loki>",
      "viz": "<timeseries|stat|gauge|bargauge|heatmap|table|logs>",
      "unit": "<grafana unit id — e.g. short, bytes, s, ms, percent, percentunit, reqps, Bps, cps>",
      "legendFormat": "<label template for multi-series panels — e.g. {{job}}, {{pod}}, {{method}}; use '' for single-series panels>",
      "rowGroup": "<row title this panel belongs to>",
      "thresholds": [{"value": null, "color": "green"}, {"value": 0.8, "color": "orange"}, {"value": 0.95, "color": "red"}],
      "min": 0,
      "max": 1
    }
  ],
  "variables": [
    { "name": "<var_name>", "label": "<Human Label>", "query": "label_values(<metric>, <label_name>)", "datasourceType": "<prometheus|loki>" }
  ],
  "timeRange": { "from": "now-1h", "to": "now" },
  "layoutHint": "<none|RED|USE|golden-signals>"
}

Rules:
- title: derive from the datasource name and metric domain. Do NOT copy the user's question. Max 6 words, title case. Examples: "OTel Receiver Metrics", "Frontend Request Rate", "Node Exporter Health".
- description: 1-2 sentences describing what the dashboard monitors. Write as a statement, not a question.
- If pre-validated queries were provided: use the EXACT expression strings from the findings. Do NOT rephrase or reconstruct.
- If an available metrics list is shown above: write PromQL expressions using ONLY those exact metric names. Do NOT use metric names outside that list. Do NOT guess names that "should" exist.
- If NO pre-validated queries AND NO available metrics list: set query to "DISCOVER" for every panel.
- Include ONE entry per panel. Assign each panel to a rowGroup.
- legendFormat: choose the label that best differentiates series (look at labels in the findings/available metrics). Set to "" for single-series panels. This is generic — use whatever label the metric actually has (e.g. {{job}}, {{pod}}, {{instance}}, {{service_name}}, {{datname}}).
- thresholds: include only for stat/gauge/bargauge. Set values appropriate for the metric domain (e.g. 0.9/0.95 for error rates, 200000000/500000000 for bytes). Omit for timeseries/heatmap/logs/table.
- min/max: include only for gauge panels to set the axis range (e.g. min:0, max:1 for a ratio). Omit for all other viz types.
- Wire template variables into queries where the label exists on the metric (e.g. {job=~"$job"}, {instance=~"$instance"} — use the actual label names, not assumed ones).
- Output only the JSON object. No markdown fences, no explanation.`;
}

// ─── Code-side layout computation ────────────────────────────────────────────

interface LayoutPanel {
    id: number;
    title: string;
    type: 'row' | 'data';
    viz?: string;           // for data panels
    query?: string;
    datasourceType?: string;
    unit?: string;
    description?: string;
    rowGroup?: string;
    gridPos: { x: number; y: number; w: number; h: number };
}

/**
 * Computes Grafana v1 gridPos for every panel (rows + data panels)
 * from the PLAN todo list.
 *
 * Layout rules (24-column grid, professional dashboard style):
 *
 * Stat/gauge/bargauge panels and timeseries/wide panels are laid out
 * together using a context-aware algorithm that prevents the "lone tiny stat"
 * problem and ensures every visual row is harmoniously filled.
 *
 * Rules:
 *   1 stat,  0 wide  → stat full-width (w=24, h=4) — single KPI banner
 *   1 stat,  1 wide  → stat (w=6, h=8) + timeseries (w=18, h=8) — KPI + trend
 *   1 stat,  2 wide  → stat (w=24, h=4) then paired timeseries below
 *   1 stat, 3+ wide  → stat (w=24, h=4) then paired timeseries below
 *   2 stats, 0 wide  → w=12 each (two half-width KPIs)
 *   2 stats, N wide  → w=12 each, then timeseries below
 *   3 stats          → w=8 each
 *   4 stats          → w=6 each
 *   5+ stats         → w=6 each, wrap after 4 per row
 *   0 stats, 1 wide  → full-width (w=24)
 *   0 stats, 2 wide  → w=12 each
 *   0 stats, 3+ wide → w=12 paired, wrapping
 *
 * The model copies these exact gridPos values verbatim — it does NOT compute layout.
 */
export function computeLayout(panelTodos: any[]): LayoutPanel[] {
    const COLS = 24;
    const result: LayoutPanel[] = [];
    let nextId = 1;
    let runningY = 0;

    const isStat = (viz: string) => viz === 'stat' || viz === 'gauge' || viz === 'bargauge';
    const WIDE_H = 8;

    // Group panels by rowGroup, preserving insertion order
    const groups: Map<string, any[]> = new Map();
    for (const p of panelTodos) {
        const g = p.rowGroup || 'General';
        if (!groups.has(g)) { groups.set(g, []); }
        groups.get(g)!.push(p);
    }

    for (const [rowTitle, panels] of groups) {
        // Row header
        result.push({
            id: nextId++,
            title: rowTitle,
            type: 'row',
            gridPos: { x: 0, y: runningY, w: COLS, h: 1 },
        });
        runningY += 1;

        const statPanels = panels.filter(p => isStat(p.viz));
        const widePanels = panels.filter(p => !isStat(p.viz));
        const nStats = statPanels.length;
        const nWide = widePanels.length;

        // ── Determine stat width and whether stats are combined with first wide panel ──
        //
        // Special case: 1 stat + 1 wide → same row, stat w=6 h=8, wide w=18 h=8
        // This is the most harmonious treatment for a KPI+trend-line pair.
        if (nStats === 1 && nWide === 1) {
            result.push({
                id: nextId++, title: statPanels[0].title, type: 'data',
                viz: statPanels[0].viz, query: statPanels[0].query,
                datasourceType: statPanels[0].datasourceType,
                unit: statPanels[0].unit, description: statPanels[0].description,
                rowGroup: rowTitle,
                gridPos: { x: 0, y: runningY, w: 6, h: WIDE_H },
            });
            result.push({
                id: nextId++, title: widePanels[0].title, type: 'data',
                viz: widePanels[0].viz, query: widePanels[0].query,
                datasourceType: widePanels[0].datasourceType,
                unit: widePanels[0].unit, description: widePanels[0].description,
                rowGroup: rowTitle,
                gridPos: { x: 6, y: runningY, w: 18, h: WIDE_H },
            });
            runningY += WIDE_H;
            continue;
        }

        // ── Pass 1: stat strip ──────────────────────────────────────────────────────
        if (nStats > 0) {
            // Stat width: adaptive so strips always fill full width
            const statW =
                nStats === 1 ? COLS :           // 1 stat → full width banner
                nStats === 2 ? 12 :             // 2 stats → half each
                nStats === 3 ? 8 :              // 3 stats → thirds
                6;                              // 4+ stats → quarters (wrap after 4)

            const statH =
                nStats === 1 && nWide === 0 ? 4 :  // single KPI banner: compact
                nStats === 1 ? 4 :                  // stat strip above timeseries: compact
                4;                                  // always 4 for stat strips

            let cx = 0;
            for (const p of statPanels) {
                if (cx + statW > COLS) {
                    runningY += statH;
                    cx = 0;
                }
                result.push({
                    id: nextId++, title: p.title, type: 'data',
                    viz: p.viz, query: p.query,
                    datasourceType: p.datasourceType,
                    unit: p.unit, description: p.description,
                    rowGroup: rowTitle,
                    gridPos: { x: cx, y: runningY, w: statW, h: statH },
                });
                cx += statW;
            }
            runningY += statH;
        }

        // ── Pass 2: wide panels ─────────────────────────────────────────────────────
        if (nWide > 0) {
            // Single wide panel → full width
            const wideW = nWide === 1 ? COLS : 12;

            let cx = 0;
            let rowH = 0;
            for (const p of widePanels) {
                if (cx + wideW > COLS) {
                    runningY += rowH;
                    cx = 0;
                    rowH = 0;
                }
                result.push({
                    id: nextId++, title: p.title, type: 'data',
                    viz: p.viz, query: p.query,
                    datasourceType: p.datasourceType,
                    unit: p.unit, description: p.description,
                    rowGroup: rowTitle,
                    gridPos: { x: cx, y: runningY, w: wideW, h: WIDE_H },
                });
                cx += wideW;
                rowH = WIDE_H;
                if (cx >= COLS) {
                    runningY += rowH;
                    cx = 0;
                    rowH = 0;
                }
            }
            if (rowH > 0) { runningY += rowH; }
        }
    }

    return result;
}

/**
 * Renders the pre-computed layout as a compact per-group block for the CREATE prompt.
 * The model copies these exact values; it must not recalculate layout.
 */
function renderLayoutForPrompt(layout: LayoutPanel[]): string {
    // Group into blocks: row header + its data panels
    const blocks: string[] = [];
    let currentRows: LayoutPanel[] = [];
    let currentData: LayoutPanel[] = [];

    const flush = () => {
        if (currentRows.length === 0) { return; }
        const rowPanel = currentRows[0];
        const gp = (p: LayoutPanel) =>
            `{"x":${p.gridPos.x},"y":${p.gridPos.y},"w":${p.gridPos.w},"h":${p.gridPos.h}}`;
        const rowLine = `ROW id=${rowPanel.id} title="${rowPanel.title}" gridPos=${gp(rowPanel)}`;
        const panelLines = currentData.map(p =>
            `  PANEL id=${p.id} viz=${p.viz} gridPos=${gp(p)} title="${p.title}"`
        );
        blocks.push([rowLine, ...panelLines].join('\n'));
        currentRows = [];
        currentData = [];
    };

    for (const p of layout) {
        if (p.type === 'row') {
            flush();
            currentRows = [p];
        } else {
            currentData.push(p);
        }
    }
    flush();
    return blocks.join('\n\n');
}

// ─── Code-built dashboard JSON ────────────────────────────────────────────────

/**
 * Builds a complete Grafana v1 dashboard JSON object from the PLAN todo list,
 * pre-computed layout, and datasource findings.
 *
 * Fully generic: works for any datasource and metric domain (OTel, Kubernetes,
 * Postgres, nginx, JVM, …). The LLM's PLAN output drives all semantic decisions
 * (queries, grouping, viz, units, thresholds, legendFormat). Code drives all
 * structural decisions (gridPos, JSON envelope, fieldConfig shape).
 */
export function buildDashboardJson(
    layout: LayoutPanel[],
    panelTodos: any[],
    variables: any[],
    timeRange: any,
    dataFindings: DataFindings,
    title: string,
    description: string,
): Record<string, unknown> {
    // Resolve default datasource from findings
    const defaultDs = dataFindings.prometheus
        ? { type: 'prometheus', uid: dataFindings.prometheus.datasourceUid }
        : dataFindings.loki
        ? { type: 'loki', uid: dataFindings.loki.datasourceUid }
        : null;

    // Map planned panel titles to their todo data (case-insensitive lookup)
    const todoByTitle = new Map<string, any>();
    for (const p of panelTodos) {
        todoByTitle.set((p.title ?? '').toLowerCase().trim(), p);
    }

    const panels: any[] = [];

    for (const lp of layout) {
        if (lp.type === 'row') {
            panels.push({
                id: lp.id,
                title: lp.title,
                type: 'row',
                collapsed: false,
                panels: [],
                gridPos: lp.gridPos,
            });
            continue;
        }

        const todo = todoByTitle.get((lp.title ?? '').toLowerCase().trim())
            ?? { query: '', unit: lp.unit ?? 'short', viz: lp.viz ?? 'timeseries' };

        const expr = (typeof todo.query === 'string' && todo.query !== 'DISCOVER') ? todo.query : '';
        const viz = lp.viz ?? todo.viz ?? 'timeseries';
        const unit = lp.unit || todo.unit || 'short';
        const panelDesc = todo.description || lp.title;

        // Datasource: use per-panel type from todo, fall back to default
        const todoDsType = todo.datasourceType ?? (dataFindings.prometheus ? 'prometheus' : 'loki');
        const panelDs = todoDsType === 'loki' && dataFindings.loki
            ? { type: 'loki', uid: dataFindings.loki.datasourceUid }
            : defaultDs ?? { type: 'prometheus', uid: '' };

        const isStat = viz === 'stat' || viz === 'gauge' || viz === 'bargauge';

        // fieldConfig: units + thresholds (only for stat-family panels)
        const fieldConfig: any = {
            defaults: { unit, color: { mode: isStat ? 'thresholds' : 'palette-classic' } },
            overrides: [],
        };
        if (isStat) {
            const hasThresholds = Array.isArray(todo.thresholds) && todo.thresholds.length > 0;
            fieldConfig.defaults.thresholds = {
                mode: 'absolute',
                steps: hasThresholds
                    ? todo.thresholds.map((t: any) => ({
                        value: t.value ?? null,
                        color: t.color ?? 'green',
                    }))
                    : [{ value: null, color: 'green' }],
            };
            // Gauge min/max — only when explicitly provided in the plan
            if (viz === 'gauge') {
                if (todo.min !== undefined && todo.min !== null) {
                    fieldConfig.defaults.min = todo.min;
                }
                if (todo.max !== undefined && todo.max !== null) {
                    fieldConfig.defaults.max = todo.max;
                }
            }
        }

        // Panel options by viz type
        const options: any = viz === 'logs'
            ? { dedupStrategy: 'none', showTime: true }
            : (viz === 'stat' || viz === 'bargauge')
            ? { reduceOptions: { calcs: ['lastNotNull'] }, colorMode: 'background' }
            : viz === 'gauge'
            ? { reduceOptions: { calcs: ['lastNotNull'] } }
            : viz === 'heatmap'
            ? { calculate: false, color: { mode: 'spectrum' }, yAxis: { unit } }
            : { tooltip: { mode: 'multi', sort: 'desc' },
                legend: { displayMode: 'list', placement: 'bottom' } };

        // legendFormat: use the plan's value; empty string means Grafana auto-labels
        // (generic — no domain-specific fallback)
        const legendFormat = typeof todo.legendFormat === 'string' ? todo.legendFormat : '';

        const targets = expr ? [{
            refId: 'A',
            datasource: panelDs,
            expr,
            legendFormat,
        }] : [];

        panels.push({
            id: lp.id,
            title: lp.title,
            description: panelDesc,
            type: viz,
            gridPos: lp.gridPos,
            fieldConfig,
            options,
            targets,
        });
    }

    // Template variables
    const templatingList = variables.map((v: any, i: number) => {
        const varDs = v.datasourceType === 'loki' && dataFindings.loki
            ? { type: 'loki', uid: dataFindings.loki.datasourceUid }
            : defaultDs ?? { type: 'prometheus', uid: '' };
        return {
            name: v.name,
            label: v.label || v.name,
            type: 'query',
            datasource: varDs,
            query: v.query,
            refresh: 2,
            includeAll: true,
            multi: true,
            allValue: '.*',
            sort: 1,
            current: {},
            options: [],
            hide: 0,
            id: `var_${i}`,
        };
    });

    return {
        title,
        description,
        uid: '',
        id: null,
        schemaVersion: 38,
        time: { from: timeRange?.from ?? 'now-1h', to: timeRange?.to ?? 'now' },
        timepicker: {},
        refresh: '30s',
        tags: [],
        panels,
        templating: { list: templatingList },
        annotations: { list: [] },
    };
}

/**
 * CREATE phase: the LLM receives the full panel todo list with pre-computed
 * gridPos values and builds the dashboard via skeleton → group-by-group patches.
 *
 * KEY DESIGN: layout arithmetic is done in code (computeLayout), not by the LLM.
 * The model copies exact gridPos values from the prompt — it never calculates them.
 * This prevents the "all panels at y=0" overlap failure.
 */
function buildCreatePhasePrompt(
    panelTodos: any[],
    variables: any[],
    timeRange: any,
    dataFindings: DataFindings,
    context: string,
    conversationDigest: string,
    schemaCapability: DashboardSchemaCapability,
    schemaRules: string,
    preferredCategories: ToolCategory[],
): string {
    const findingsBlock = formatFindingsForPrompt(dataFindings);
    const hasValidatedQueries =
        (dataFindings.loki?.validatedQueries?.length ?? 0) > 0 ||
        (dataFindings.prometheus?.validatedQueries?.length ?? 0) > 0;

    // Pre-compute layout in code — the model copies these values, never calculates them
    const layout = computeLayout(panelTodos);
    const layoutBlock = renderLayoutForPrompt(layout);

    const varList = variables.length > 0
        ? `\nTemplate variables to include in the skeleton's templating.list:\n${variables.map((v: any) =>
            `  - ${v.name} (${v.datasourceType}): ${v.query}`
        ).join('\n')}`
        : '';

    // Build a per-panel reference map: id → todo data (query, unit, datasourceType, etc.)
    // so the model can look up the right query/unit by panel id
    const dataLayouts = layout.filter(p => p.type === 'data');
    const hasDiscoverPanels = dataLayouts.some(p => p.query === 'DISCOVER');

    const discoverInstructions = hasDiscoverPanels ? `
## DISCOVER MODE — find real metric names before writing panels

Some panels are marked "DISCOVER". This means no pre-validated queries were available,
so you MUST discover the actual metric names from the datasource before writing those panels.

MANDATORY for DISCOVER panels:
1. Call list_datasources to get the datasource uid and type.
2. Call list_prometheus_metric_names (or equivalent) to get the full list of available metrics.
3. From that list, choose the REAL metric names that match each panel's purpose.
4. ONLY use metric names that actually exist in the list — never invent or guess names.
5. Write the panel with the real expr.

CRITICAL: Do NOT use metric names from general knowledge. A metric name that doesn't exist in the
datasource will show "No data" permanently. Fabricated metrics are worse than no panel at all.` : '';

    return `You are a dashboard construction agent for Graft, an AI assistant embedded in Grafana.

You have access to dashboard and datasource tools ONLY — no query tools.
${hasDiscoverPanels ? 'Some panels have query="DISCOVER" — you MUST look up real metric names before writing those panels (see DISCOVER MODE section below).' : 'All queries below have been pre-validated — copy them VERBATIM.'}

${conversationDigest ? `## Recent conversation\n${conversationDigest}\n\n` : ''}\
${hasValidatedQueries ? `## Pre-validated data\n${findingsBlock}\n\n` :
  buildEmptyFindingsGuidance(preferredCategories) + '\n\n'}
${varList ? `${varList}\n\n` : ''}
${schemaRules}
${discoverInstructions}

## PRE-COMPUTED LAYOUT (copy exact gridPos values — do NOT recalculate)

The following layout has been computed for you. Each panel has an id, a pre-computed
gridPos, and the query/unit to use. You MUST use these exact gridPos values verbatim —
do not adjust, recalculate, or substitute different values.

${layoutBlock}

## Panel details (query + unit + datasource for each panel id)
${dataLayouts.map(p => {
    const ds = p.datasourceType === 'loki'
        ? (dataFindings.loki ? `{"type":"loki","uid":"${dataFindings.loki.datasourceUid}"}` : '{"type":"loki","uid":"<loki-uid>"}')
        : (dataFindings.prometheus ? `{"type":"prometheus","uid":"${dataFindings.prometheus.datasourceUid}"}` : '{"type":"prometheus","uid":"<prom-uid>"}');
    const exprNote = p.query === 'DISCOVER'
        ? '⚠ DISCOVER — call list_prometheus_metric_names to find the real expr for this panel'
        : p.query;
    return `Panel id=${p.id} "${p.title}"
  viz: ${p.viz}  unit: ${p.unit || 'short'}  description: ${p.description || p.title}
  datasource: ${ds}
  expr: ${exprNote}`;
}).join('\n\n')}

## MANDATORY BUILD SEQUENCE — follow these steps IN ORDER

### Step 1 — Create the skeleton (empty panels: [])
Call update_dashboard once with full JSON. Panels must be empty — NO panels yet.
{
  "dashboard": {
    "title": "<descriptive title>",
    "description": "<1-2 sentence description>",
    "uid": "",
    "id": null,
    "panels": [],
    "schemaVersion": 38,
    "time": { "from": "${timeRange?.from ?? 'now-1h'}", "to": "${timeRange?.to ?? 'now'}" },
    "timepicker": {},
    "refresh": "30s",
    "tags": [],
    "templating": { "list": [ /* template variables here if any */ ] },
    "annotations": { "list": [] }
  },
  "folderUid": "",
  "overwrite": false
}
The response contains the assigned UID — note it immediately for all following steps.

### Step 2 — Add panels GROUP BY GROUP (one patch call per row group, in order)

CRITICAL GRAFANA RULE: a row panel "owns" all the panels that follow it in the array
until the next row panel. You MUST add the row panel AND its data panels together,
in a single patch call per group. Do NOT add all rows first then data panels — that
puts every data panel under the LAST row.

For EACH row group (in order), call update_dashboard in patch mode:
{
  "uid": "<uid from Step 1>",
  "operations": [
    { "op": "add", "path": "$.panels/- ", "value": {
        "type": "row",
        "title": "<row title>",
        "id": <ROW id from layout above>,
        "collapsed": false,
        "panels": [],
        "gridPos": <gridPos from layout above — copy exactly>
      }
    },
    { "op": "add", "path": "$.panels/- ", "value": {
        "id": <PANEL id from layout above>,
        "title": "<panel title>",
        "description": "<description>",
        "type": "<viz>",
        "gridPos": <gridPos from layout above — copy exactly>,
        "fieldConfig": {
          "defaults": { "unit": "<unit>", "color": { "mode": "palette-classic" } },
          "overrides": []
        },
        "options": {},
        "targets": [{
          "refId": "A",
          "datasource": <datasource JSON>,
          "expr": "<query>",
          "legendFormat": "{{job}}"
        }]
      }
    }
  ],
  "overwrite": true
}
Repeat for every row group. Use the exact id and gridPos values from the layout above.

### Step 3 — Confirm and report
After all patch calls succeed, include in your final message:
- [Open dashboard](/d/<uid>)
- Number of panels per group

DO NOT call get_dashboard_panel_queries or get_dashboard_summary — those are called automatically after you finish.
${schemaCapability === 'v2-capable' ? '\nNOTE: V2 schema also supported — see rules above.' : ''}

${context ? `## Current Grafana context\n${context}` : ''}`;
}

/**
 * REPAIR phase: the LLM receives a structured gap report and applies targeted
 * patch operations to close each gap.
 *
 * For empty dashboards, the pre-computed layout is injected so the model can
 * write correct gridPos values in the mandatory full-JSON rewrite.
 */
function buildRepairPhasePrompt(
    gaps: DashboardGaps,
    dashboardUid: string,
    dataFindings: DataFindings,
    schemaRules: string,
    context: string,
    layout: LayoutPanel[],
): string {
    const gapLines: string[] = [];
    if (gaps.emptyDashboard) {
        gapLines.push(`CRITICAL: The dashboard has ZERO data panels (panelCount=${gaps.livePanelCount}). Add ALL planned panels now.`);
    }
    if (gaps.missingPanels.length > 0) {
        gapLines.push(`Missing panels (must be added):\n${gaps.missingPanels.map(t => `  - ${t}`).join('\n')}`);
    }
    if (gaps.datasourceMismatches.length > 0) {
        gapLines.push(`Datasource mismatches (must fix):\n${gaps.datasourceMismatches.map(
            m => `  - Panel "${m.title}": uses ${m.datasourceType} datasource but query is ${isLogQL(m.query) ? 'LogQL' : 'PromQL'}`
        ).join('\n')}`);
    }
    if (gaps.panelsWithoutDescription.length > 0) {
        gapLines.push(`Panels missing description:\n${gaps.panelsWithoutDescription.map(t => `  - ${t}`).join('\n')}`);
    }

    const findingsBlock = formatFindingsForPrompt(dataFindings);
    const layoutBlock = layout.length > 0 ? renderLayoutForPrompt(layout) : '';
    const dataLayouts = layout.filter(p => p.type === 'data');

    const layoutDetails = dataLayouts.length > 0 ? `
## PRE-COMPUTED LAYOUT (use exact gridPos values)
${layoutBlock}

## Panel details
${dataLayouts.map(p => {
    const ds = p.datasourceType === 'loki'
        ? (dataFindings.loki ? `{"type":"loki","uid":"${dataFindings.loki.datasourceUid}"}` : '{"type":"loki","uid":"<loki-uid>"}')
        : (dataFindings.prometheus ? `{"type":"prometheus","uid":"${dataFindings.prometheus.datasourceUid}"}` : '{"type":"prometheus","uid":"<prom-uid>"}');
    return `Panel id=${p.id} "${p.title}" | viz:${p.viz} unit:${p.unit||'short'} | datasource:${ds} | expr:${p.query}`;
}).join('\n')}` : '';

    return `You are a dashboard repair agent for Graft. Dashboard uid="${dashboardUid}" has quality gaps that MUST be fixed.

## Gaps to fix
${gapLines.join('\n\n')}

${findingsBlock ? `## Pre-validated queries (use these verbatim)\n${findingsBlock}\n` : ''}
${layoutDetails}

## How to fix

${gaps.emptyDashboard ? `### EMPTY DASHBOARD — MANDATORY FULL-JSON REWRITE
The dashboard has zero panels. patch operations CANNOT work on a null panels array.
You MUST call update_dashboard with a full-JSON body containing ALL panels.
Use the exact gridPos values from the PRE-COMPUTED LAYOUT above.
Interleave rows and their panels: [Row1, Row1-panelA, Row1-panelB, Row2, Row2-panelA, ...]
{
  "dashboard": {
    "title": "<descriptive title>",
    "description": "<description>",
    "uid": "${dashboardUid}",
    "panels": [ /* all rows + data panels with correct gridPos from layout above */ ],
    "schemaVersion": 38,
    "time": { "from": "now-1h", "to": "now" },
    "timepicker": {}, "refresh": "30s", "tags": [],
    "templating": { "list": [] }, "annotations": { "list": [] }
  },
  "folderUid": "",
  "overwrite": true
}` :
`### Adding missing panels (panels array already exists, patches safe)
Use update_dashboard with patch operations to APPEND panels:
  { "uid": "${dashboardUid}", "operations": [{ "op": "add", "path": "$.panels/- ", "value": { <panel JSON> } }], "overwrite": true }
Add one operation per missing panel. Row panels first, then data panels.`}

### Fixing datasource mismatches
Use a patch replace on the specific target:
  { "uid": "${dashboardUid}", "operations": [{ "op": "replace", "path": "$.panels[<idx>].targets[0].datasource", "value": {"type":"<correct_type>","uid":"<correct_uid>"} }], "overwrite": true }
Use get_dashboard_summary to find the panel array index if needed.

### Adding missing descriptions
  { "uid": "${dashboardUid}", "operations": [{ "op": "replace", "path": "$.panels[<idx>].description", "value": "<description>" }], "overwrite": true }

${schemaRules}

${context ? `## Current Grafana context\n${context}` : ''}

After applying all fixes, confirm with a brief summary of what was changed.`;
}

// ─── MCP tool invocation helper ───────────────────────────────────────────────

async function callTool(
    mcpClient: any,
    name: string,
    args: Record<string, unknown>,
    toolExecutions: ToolExecution[],
    onUpdate: (te: ToolExecution[]) => void,
): Promise<string> {
    toolExecutions.push({ name, status: 'pending' });
    onUpdate(toolExecutions.map(t => ({ ...t })));
    try {
        const result = await mcpClient.callTool({ name, arguments: args });
        const rawResult = JSON.stringify(result.content);
        const idx = findLastIndex(toolExecutions, t => t.name === name && t.status === 'pending');
        if (idx !== -1) { toolExecutions[idx].status = 'success'; }
        onUpdate(toolExecutions.map(t => ({ ...t })));
        return rawResult;
    } catch (err: any) {
        const idx = findLastIndex(toolExecutions, t => t.name === name && t.status === 'pending');
        if (idx !== -1) {
            toolExecutions[idx].status = 'error';
            toolExecutions[idx].error = err.message;
        }
        onUpdate(toolExecutions.map(t => ({ ...t })));
        throw err;
    }
}

// ─── LLM single-turn helper (agentic loop for one phase) ─────────────────────

interface LoopResult {
    content: string;
    toolExecutions: ToolExecution[];
    createdDashboardUid?: string;
    resolvedSchema: DashboardSchemaCapability;
    v2FallbackNote: string;
}

async function runAgentLoop(
    systemPrompt: string,
    userMessage: string,
    scopedTools: any[],
    mcpClient: any,
    maxIterations: number,
    signal: AbortSignal,
    step: PlanStep,
    existingToolExecutions: ToolExecution[],
    onUpdate: (stepId: string, toolExecutions: ToolExecution[]) => void,
    schemaCapabilityHint: DashboardSchemaCapability,
    dataFindings: DataFindings,
    context: string,
    preferredCategories: ToolCategory[],
    conversationDigest: string,
    existingDashboardUid?: string,
): Promise<LoopResult> {
    const toolExecutions = existingToolExecutions;
    let fullContent = '';
    let iteration = 0;
    let createdDashboardUid = existingDashboardUid;
    let resolvedSchema = schemaCapabilityHint;
    let v2FallbackNote = '';

    const llmMessages: any[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
    ];

    const wrapOnUpdate = (te: ToolExecution[]) => onUpdate(step.id, te);

    let response = await llm.chatCompletions({
        model: llm.Model.LARGE,
        messages: llmMessages,
        tools: scopedTools.length > 0 ? scopedTools : undefined,
    } as any);

    let toolCalls = response.choices?.[0]?.message?.tool_calls ?? [];
    fullContent = response.choices?.[0]?.message?.content ?? '';

    while (toolCalls.length > 0 && iteration < maxIterations) {
        if (signal.aborted) { throw new Error('Aborted'); }
        iteration++;

        llmMessages.push({ role: 'assistant', content: fullContent, tool_calls: toolCalls });

        for (const toolCall of toolCalls) {
            if (signal.aborted) { throw new Error('Aborted'); }

            toolExecutions.push({ name: toolCall.function.name, status: 'pending' });
            wrapOnUpdate(toolExecutions.map(t => ({ ...t })));

            let rawResult = '';
            try {
                if (!mcpClient) { throw new Error('MCP client not available'); }
                const args = normalizeToolArgs(JSON.parse(toolCall.function.arguments));
                const result = await mcpClient.callTool({ name: toolCall.function.name, arguments: args });
                rawResult = JSON.stringify(result.content);

                // UID extraction from update_dashboard
                if (toolCall.function.name === 'update_dashboard' && !createdDashboardUid) {
                    createdDashboardUid = extractDashboardUid(rawResult);
                }

                // Authoritative V2 capability probe after skeleton get_dashboard_by_uid
                if (toolCall.function.name === 'get_dashboard_by_uid' && createdDashboardUid) {
                    const probed = resolveSchemaFromProbeResult(rawResult, schemaCapabilityHint);
                    if (probed !== resolvedSchema) {
                        resolvedSchema = probed;
                        const updatedPrompt = buildCreatePhasePrompt(
                            [], [], null, dataFindings, context, conversationDigest,
                            resolvedSchema,
                            resolvedSchema === 'v2-capable' ? buildV2Rules(dataFindings.layoutHint) : buildV1PanelRules(dataFindings.layoutHint),
                            preferredCategories,
                        );
                        llmMessages[0] = { role: 'system', content: updatedPrompt };
                    }
                }

                // V2 write failure → fall back to v1
                if (toolCall.function.name === 'update_dashboard' &&
                    resolvedSchema === 'v2-capable' &&
                    (rawResult.includes('Kubernetes-capable Grafana is required') ||
                     rawResult.includes('k8s client is not available'))) {
                    resolvedSchema = 'v1';
                    v2FallbackNote = '\n\n> **Note:** V2 schema write failed. Dashboard rebuilt as Classic v1.';
                    const updatedPrompt = buildCreatePhasePrompt(
                        [], [], null, dataFindings, context, conversationDigest,
                        'v1', buildV1PanelRules(dataFindings.layoutHint),
                        preferredCategories,
                    );
                    llmMessages[0] = { role: 'system', content: updatedPrompt };
                }

                llmMessages.push({ role: 'tool', content: rawResult, tool_call_id: toolCall.id });

                const idx = findLastIndex(toolExecutions,
                    (t: ToolExecution) => t.name === toolCall.function.name && t.status === 'pending');
                if (idx !== -1) { toolExecutions[idx].status = 'success'; }
            } catch (err: any) {
                rawResult = `Error: ${err.message}`;
                llmMessages.push({ role: 'tool', content: rawResult, tool_call_id: toolCall.id });
                const idx = findLastIndex(toolExecutions,
                    (t: ToolExecution) => t.name === toolCall.function.name && t.status === 'pending');
                if (idx !== -1) {
                    toolExecutions[idx].status = 'error';
                    toolExecutions[idx].error = err.message;
                }
            }
            wrapOnUpdate(toolExecutions.map(t => ({ ...t })));
        }

        // Compress non-dashboard tool results to save context
        for (const toolCall of toolCalls) {
            if (NO_COMPRESS.has(toolCall.function.name)) { continue; }
            const msgIdx = findLastIndex(llmMessages,
                (m: any) => m.role === 'tool' && m.tool_call_id === toolCall.id);
            if (msgIdx !== -1) {
                const original = llmMessages[msgIdx].content;
                const preview = original.length > 300 ? original.slice(0, 300) + '...' : original;
                llmMessages[msgIdx] = {
                    ...llmMessages[msgIdx],
                    content: `[${toolCall.function.name} result — summary: ${preview}]`,
                };
            }
        }

        if (signal.aborted) { throw new Error('Aborted'); }

        response = await llm.chatCompletions({
            model: llm.Model.LARGE,
            messages: llmMessages,
            tools: scopedTools.length > 0 ? scopedTools : undefined,
        } as any);

        toolCalls = response.choices?.[0]?.message?.tool_calls ?? [];
        fullContent = response.choices?.[0]?.message?.content ?? fullContent;
    }

    return { content: fullContent, toolExecutions, createdDashboardUid, resolvedSchema, v2FallbackNote };
}

// ─── Phase helpers ────────────────────────────────────────────────────────────

/** Parse the panel todo list from the PLAN phase response. Returns null on failure. */
function parsePlanResponse(content: string): { panels: any[]; variables: any[]; timeRange: any; layoutHint?: string; title?: string; description?: string } | null {
    try {
        let json = content.trim();
        const fence = json.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fence) { json = fence[1].trim(); }
        const start = json.indexOf('{');
        const end = json.lastIndexOf('}');
        if (start !== -1 && end > start) { json = json.slice(start, end + 1); }
        const parsed = JSON.parse(json);
        if (!Array.isArray(parsed.panels)) { return null; }
        return {
            panels: parsed.panels,
            variables: Array.isArray(parsed.variables) ? parsed.variables : [],
            timeRange: parsed.timeRange ?? { from: 'now-1h', to: 'now' },
            layoutHint: parsed.layoutHint,
            title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : undefined,
            description: typeof parsed.description === 'string' && parsed.description.trim() ? parsed.description.trim() : undefined,
        };
    } catch {
        return null;
    }
}

// ─── Main agent entry point ───────────────────────────────────────────────────

/**
 * Phase machine: PLAN → CREATE → VERIFY → REPAIR → DONE
 *
 * Code owns control flow. The LLM owns panel content.
 * Cannot return success while emptyDashboard or missingPanels remain.
 */
export async function runDashboardAgent(
    step: PlanStep,
    userMessage: string,
    context: string,
    dataFindings: DataFindings,
    allTools: any[],
    mcpClient: any,
    maxIterations: number,
    signal: AbortSignal,
    onUpdate: (stepId: string, toolExecutions: ToolExecution[]) => void,
    preferredCategories: ToolCategory[] = [],
    conversationDigest = '',
    schemaCapabilityHint: DashboardSchemaCapability = 'v1',
): Promise<SpecialistResult> {
    // Enrich findings with deterministic unit/viz/threshold metadata
    const enrichedFindings = enrichDataFindings(dataFindings, step.description, userMessage);

    const scopedTools = scopeDashboardTools(allTools);
    const toolExecutions: ToolExecution[] = [];
    const wrapOnUpdate = (te: ToolExecution[]) => onUpdate(step.id, te);

    let resolvedSchema: DashboardSchemaCapability = schemaCapabilityHint;
    let createdDashboardUid: string | undefined;
    let v2FallbackNote = '';
    let finalContent = '';

    const schemaRules = () => resolvedSchema === 'v2-capable'
        ? buildV2Rules(enrichedFindings.layoutHint)
        : buildV1PanelRules(enrichedFindings.layoutHint);

    // Phase budgets — total iterations split across phases
    const planBudget = Math.min(3, maxIterations);
    const createBudget = Math.min(Math.floor(maxIterations * 0.4), 20);
    const repairBudget = Math.max(maxIterations - planBudget - createBudget, 5);
    const MAX_PLAN_RETRIES = 2;
    const MAX_REPAIR_ROUNDS = 3;

    try {

        // ═══════════════════════════════════════════════════════════════════
        // PHASE 1 — PLAN
        // The LLM analyses findings + request and outputs a panel todo list.
        // Gate: at least 1 panel in the todo list.
        // ═══════════════════════════════════════════════════════════════════

        let planResult: { panels: any[]; variables: any[]; timeRange: any; layoutHint?: string } | null = null;
        let planAttempt = 0;

        while (!planResult && planAttempt <= MAX_PLAN_RETRIES) {
            if (signal.aborted) { throw new Error('Aborted'); }
            planAttempt++;

            const planPrompt = buildPlanPhasePrompt(
                enrichedFindings, userMessage, context, conversationDigest, preferredCategories,
            );

            // PLAN is a single completion — no tools needed
            const planResponse = await llm.chatCompletions({
                model: llm.Model.LARGE,
                messages: [
                    { role: 'system', content: planPrompt },
                    { role: 'user', content: userMessage },
                ],
            } as any);

            const planContent = planResponse.choices?.[0]?.message?.content ?? '';
            const parsed = parsePlanResponse(planContent);

            if (parsed && parsed.panels.length > 0) {
                planResult = parsed;
                // Propagate layout hint from plan into findings if not already set
                if (parsed.layoutHint && parsed.layoutHint !== 'none') {
                    enrichedFindings.layoutHint = parsed.layoutHint as any;
                }
            }
            // If empty or unparseable, retry with an explicit correction message
        }

        // If the plan still has no panels, fall through gracefully with an empty plan
        const plannedPanels = planResult?.panels ?? [];
        const plannedVariables = planResult?.variables ?? [];
        const plannedTimeRange = planResult?.timeRange ?? { from: 'now-1h', to: 'now' };
        const plannedTitles = plannedPanels.map((p: any) => String(p.title ?? ''));

        // Pre-compute layout once — used by both CREATE and REPAIR prompts
        const layout = computeLayout(plannedPanels);

        // ═══════════════════════════════════════════════════════════════════
        // PHASE 2 — CREATE
        // Build and write the complete dashboard in one update_dashboard call.
        // Gate: update_dashboard succeeded and UID extracted.
        // Retry up to 2 times on error.
        // ═══════════════════════════════════════════════════════════════════

        // ═══════════════════════════════════════════════════════════════════
        // PHASE 2 — CREATE (code-built, not LLM-built)
        //
        // Layout, gridPos, units, and viz type are determined entirely in code
        // using buildDashboardJson + computeLayout. The LLM only supplied
        // queries, titles, and descriptions in the PLAN phase.
        //
        // This is the key fix: the model can no longer produce incorrect
        // gridPos values, mixed heights, or wrong stat/timeseries ordering.
        //
        // Gate: update_dashboard succeeded and UID extracted.
        // ═══════════════════════════════════════════════════════════════════

        if (plannedPanels.length > 0 && mcpClient) {
            // Use the LLM-generated title/description from the PLAN phase — it knows the
            // datasource and metric domain. Fall back to the planner's step description.
            const dashTitle = planResult?.title || step.description;
            const dashDesc = planResult?.description || `Dashboard for: ${step.description}`;

            const dashboardJson = buildDashboardJson(
                layout, plannedPanels, plannedVariables, plannedTimeRange,
                enrichedFindings, dashTitle, dashDesc,
            );

            try {
                const rawResult = await callTool(
                    mcpClient, 'update_dashboard',
                    { dashboard: dashboardJson, folderUid: '', overwrite: false },
                    toolExecutions, wrapOnUpdate,
                );
                createdDashboardUid = extractDashboardUid(rawResult);
                finalContent = createdDashboardUid
                    ? `Dashboard created: [Open dashboard](/d/${createdDashboardUid})`
                    : 'Dashboard creation failed — no UID returned.';
            } catch (err: any) {
                finalContent = `Dashboard creation failed: ${err.message}`;
            }
        } else if (plannedPanels.length === 0) {
            // No panels from PLAN — fall back to LLM-driven CREATE for discovery
            const createSystemPrompt = buildCreatePhasePrompt(
                plannedPanels, plannedVariables, plannedTimeRange,
                enrichedFindings, context, conversationDigest,
                resolvedSchema, schemaRules(), preferredCategories,
            );

            let createAttempt = 0;
            let createResult: LoopResult | undefined;

            while (createAttempt < 2 && !createdDashboardUid) {
                if (signal.aborted) { throw new Error('Aborted'); }
                createAttempt++;

                createResult = await runAgentLoop(
                    createSystemPrompt, userMessage,
                    scopedTools, mcpClient, createBudget, signal,
                    step, toolExecutions, onUpdate,
                    resolvedSchema, enrichedFindings, context,
                    preferredCategories, conversationDigest, createdDashboardUid,
                );

                createdDashboardUid = createResult.createdDashboardUid;
                resolvedSchema = createResult.resolvedSchema;
                v2FallbackNote = createResult.v2FallbackNote;
                finalContent = createResult.content;
            }
        }

        // ═══════════════════════════════════════════════════════════════════
        // PHASE 3 — VERIFY + REPAIR loop
        // Code calls get_dashboard_summary + get_dashboard_panel_queries,
        // assesses gaps, and drives the LLM to patch them.
        // Cannot exit while emptyDashboard or missingPanels remain.
        // ═══════════════════════════════════════════════════════════════════

        if (createdDashboardUid && mcpClient) {
            for (let repairRound = 0; repairRound < MAX_REPAIR_ROUNDS; repairRound++) {
                if (signal.aborted) { throw new Error('Aborted'); }

                // VERIFY — always call get_dashboard_summary first.
                // Only call get_dashboard_panel_queries when panelCount > 0
                // (it returns null on empty dashboards, causing downstream crashes).
                let summary: DashboardSummaryResult | undefined;
                let panelQueries: PanelQueryResult[] | undefined;

                try {
                    const summaryRaw = await callTool(
                        mcpClient, 'get_dashboard_summary',
                        { uid: createdDashboardUid },
                        toolExecutions, wrapOnUpdate,
                    );
                    summary = unwrapMcpResult(summaryRaw) as DashboardSummaryResult | undefined;
                } catch { /* summary fetch failed — proceed without it */ }

                // Only fetch panel queries when the dashboard actually has panels
                const livePanelCount = (summary?.panels ?? []).filter((p: PanelSummary) => p.type !== 'row').length;
                if (livePanelCount > 0) {
                    try {
                        const queriesRaw = await callTool(
                            mcpClient, 'get_dashboard_panel_queries',
                            { uid: createdDashboardUid },
                            toolExecutions, wrapOnUpdate,
                        );
                        const qUnwrapped = unwrapMcpResult(queriesRaw);
                        panelQueries = Array.isArray(qUnwrapped) ? qUnwrapped : undefined;
                    } catch { /* panel queries fetch failed — proceed without it */ }
                }

                const gaps = assessDashboardCompleteness(summary, panelQueries, plannedTitles);

                // Clean exit — no gaps worth repairing
                if (!gaps.emptyDashboard && gaps.missingPanels.length === 0 && gaps.datasourceMismatches.length === 0) {
                    break;
                }

                // REPAIR — give the LLM the gap report, original findings, and pre-computed layout
                const repairPrompt = buildRepairPhasePrompt(
                    gaps, createdDashboardUid,
                    enrichedFindings, schemaRules(), context,
                    layout,
                );

                const gapSummary = [
                    gaps.emptyDashboard ? `${gaps.livePanelCount} panels (empty!)` : `${gaps.livePanelCount} panels`,
                    gaps.missingPanels.length > 0 ? `missing: ${gaps.missingPanels.join(', ')}` : '',
                    gaps.datasourceMismatches.length > 0 ? `${gaps.datasourceMismatches.length} datasource mismatch(es)` : '',
                ].filter(Boolean).join('; ');

                const correctionMessage = `The dashboard currently has gaps: ${gapSummary}. Fix them now using update_dashboard.`;

                const repairResult = await runAgentLoop(
                    repairPrompt, correctionMessage,
                    scopedTools, mcpClient, repairBudget, signal,
                    step, toolExecutions, onUpdate,
                    resolvedSchema, enrichedFindings, context,
                    preferredCategories, conversationDigest, createdDashboardUid,
                );

                if (repairResult.content) { finalContent = repairResult.content; }
                if (repairResult.createdDashboardUid) { createdDashboardUid = repairResult.createdDashboardUid; }
            }
        }

        // ═══════════════════════════════════════════════════════════════════
        // PHASE 4 — DONE
        // Compose the final summary, guaranteeing the dashboard link.
        // ═══════════════════════════════════════════════════════════════════

        if (!finalContent) {
            finalContent = `Dashboard step "${step.description}" completed with ${toolExecutions.length} tool call(s).`;
        }

        if (createdDashboardUid && !finalContent.includes(`/d/${createdDashboardUid}`)) {
            finalContent += `\n\n[Open dashboard](/d/${createdDashboardUid})`;
        }

        if (v2FallbackNote) { finalContent += v2FallbackNote; }

        return {
            stepId: step.id,
            status: 'success',
            summary: finalContent,
            toolExecutions,
            dashboardUid: createdDashboardUid,
        };

    } catch (err: any) {
        if (err.message === 'Aborted') { throw err; }
        const uidHint = createdDashboardUid
            ? ` Dashboard was created at [/d/${createdDashboardUid}](/d/${createdDashboardUid}).`
            : '';
        return {
            stepId: step.id,
            status: 'error',
            summary: `Dashboard step "${step.description}" failed.${uidHint}`,
            error: err.message,
            toolExecutions,
            dashboardUid: createdDashboardUid,
        };
    }
}
