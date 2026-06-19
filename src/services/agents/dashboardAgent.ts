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

    return `You are a dashboard planning agent for Graft, an AI assistant embedded in Grafana.
Your task: analyse the user request and the pre-validated query findings below, then output a
STRUCTURED PANEL TODO LIST that the dashboard construction agent will use as its contract.

${conversationDigest ? `## Recent conversation\n${conversationDigest}\n\n` : ''}\
${hasValidatedQueries ? `## Pre-validated queries\n${findingsBlock}` :
  hasKnownDatasource ? `## Datasource identified\n${findingsBlock}\n\n${buildEmptyFindingsGuidance(preferredCategories)}` :
  buildEmptyFindingsGuidance(preferredCategories)}

${context ? `## Current Grafana context\n${context}` : ''}

## Output format (REQUIRED — output ONLY this JSON, no prose, no fences)
{
  "panels": [
    {
      "title": "<panel title>",
      "description": "<what this panel shows>",
      "query": "<the PromQL or LogQL expression>",
      "datasourceType": "<prometheus|loki>",
      "viz": "<timeseries|stat|gauge|bargauge|heatmap|table|logs>",
      "unit": "<grafana unit id or empty string>",
      "rowGroup": "<row title this panel belongs to>",
      "thresholds": [{"value": null, "color": "green"}, ...] // only for stat/gauge/bargauge
    }
  ],
  "variables": [
    { "name": "<var_name>", "label": "<Human Label>", "query": "label_values(<metric>, <label>)", "datasourceType": "<prometheus|loki>" }
  ],
  "timeRange": { "from": "now-1h", "to": "now" },
  "layoutHint": "<none|RED|USE|golden-signals>"
}

Rules:
- Include ONE entry per panel in the final dashboard. DO NOT omit panels from the findings.
- Every validated query in the findings MUST appear as at least one panel.
- Use the EXACT query expressions from the findings — do not rephrase or reconstruct.
- Assign each panel to a rowGroup (at minimum one row per datasource type, or by signal/service).
- Output only the JSON object. No markdown fences, no explanation.`;
}

/**
 * CREATE phase: the LLM receives the full panel todo list and builds the
 * dashboard using an explicit skeleton → rows → panels sequence.
 *
 * The three-step sequence is mandatory and ordered:
 *   Step 1: update_dashboard with skeleton (panels: []) → extract UID from response
 *   Step 2: patch rows (one add op per row group, in order)
 *   Step 3: patch data panels per row group (one add op per panel)
 *
 * This avoids the "one giant JSON" failure mode where the model sends a
 * payload too large for the LLM context or the model omits panels.
 * get_dashboard_panel_queries must NOT be called here — only after VERIFY
 * confirms panelCount > 0.
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

    // Derive unique row groups in order
    const rowGroups: string[] = [];
    for (const p of panelTodos) {
        if (p.rowGroup && !rowGroups.includes(p.rowGroup)) { rowGroups.push(p.rowGroup); }
    }

    const panelList = panelTodos.map((p, i) =>
        `${i + 1}. [${p.rowGroup}] ${p.title} | ${p.viz} | unit:${p.unit || 'short'} | ${p.datasourceType} | query: ${p.query}`
    ).join('\n');

    const varList = variables.length > 0
        ? `\nTemplate variables to include in the skeleton's templating.list:\n${variables.map((v: any) =>
            `  - ${v.name} (${v.datasourceType}): ${v.query}`
        ).join('\n')}`
        : '';

    const rowList = rowGroups.map((r, i) => `  Row ${i + 1}: "${r}"`).join('\n');

    return `You are a dashboard construction agent for Graft, an AI assistant embedded in Grafana.

You have access to dashboard and datasource tools ONLY — no query tools.
All queries below have been pre-validated — copy them VERBATIM.

${conversationDigest ? `## Recent conversation\n${conversationDigest}\n\n` : ''}\
${hasValidatedQueries ? `## Pre-validated data\n${findingsBlock}\n\n` :
  buildEmptyFindingsGuidance(preferredCategories) + '\n\n'}
## Panel Todo List
${panelList}
${varList}

## Row groups (in order)
${rowList || '  (no rows — flat layout)'}

Time range: ${timeRange?.from ?? 'now-1h'} to ${timeRange?.to ?? 'now'}

${schemaRules}

## MANDATORY BUILD SEQUENCE — follow these steps IN ORDER

### Step 1 — Create the skeleton (empty panels: [])
Call update_dashboard with a full JSON body. Use uid:"" and panels:[] — no panels yet.
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
The response contains the assigned UID — note it immediately for all following patch steps.

### Step 2 — Add panels GROUP BY GROUP (one patch call per row group, in order)

CRITICAL GRAFANA RULE: In the flat panels[] array, a row panel "owns" all the panels
that follow it until the next row panel. You MUST interleave row panels and their data
panels — do NOT add all rows first. The correct array structure is:
  [Row1-panel, Row1-data-panel-A, Row1-data-panel-B, Row2-panel, Row2-data-panel-A, ...]

For EACH row group (in order), make ONE patch call that appends the row panel IMMEDIATELY
followed by that row's data panels — all in a single operations array:
{
  "uid": "<uid from Step 1>",
  "operations": [
    { "op": "add", "path": "$.panels/- ", "value": { "type": "row", "title": "<Row title>", "id": <id>, "collapsed": false, "gridPos": { "h": 1, "w": 24, "x": 0, "y": 0 }, "panels": [] } },
    { "op": "add", "path": "$.panels/- ", "value": { <complete data panel JSON for first panel in this row> } },
    { "op": "add", "path": "$.panels/- ", "value": { <complete data panel JSON for second panel in this row> } }
  ],
  "overwrite": true
}
Then call the SAME pattern for the next row group. Repeat until all row groups are added.

For each data panel include the full object: id, title, description, type, gridPos, fieldConfig (with unit), targets (with datasource + expr/query + legendFormat), options.
- type: use the viz value from the Panel Todo List
- fieldConfig.defaults.unit: use the unit from the Panel Todo List
- targets[0].datasource: exact datasource JSON from the Pre-validated data section
- targets[0].expr (Prometheus) or targets[0].expr (Loki): EXACT query from the list
- targets[0].legendFormat: meaningful label e.g. "{{job}}" or static string
- gridPos y: just use 0 for all panels — Grafana will re-layout automatically

Assign sequential integer ids starting from 1 across all panels.

### Step 3 — Confirm and report
After all patch calls succeed, your final message must include:
- [Open dashboard](/d/<uid>)
- Number of panels added per row group
- Any issues encountered

DO NOT call get_dashboard_panel_queries or get_dashboard_summary — those are called by the system after you finish.
${schemaCapability === 'v2-capable' ? '\nNOTE: V2 schema also supported on this Grafana — see rules above.' : ''}

${context ? `## Current Grafana context\n${context}` : ''}`;
}

/**
 * REPAIR phase: the LLM receives a structured gap report and applies targeted
 * patch operations to close each gap.
 */
function buildRepairPhasePrompt(
    gaps: DashboardGaps,
    dashboardUid: string,
    dataFindings: DataFindings,
    schemaRules: string,
    context: string,
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

    return `You are a dashboard repair agent for Graft. Dashboard uid="${dashboardUid}" has quality gaps that MUST be fixed.

## Gaps to fix
${gapLines.join('\n\n')}

${findingsBlock ? `## Pre-validated queries (use these verbatim)\n${findingsBlock}\n` : ''}

## How to fix

${gaps.emptyDashboard ? `### EMPTY DASHBOARD — MANDATORY FULL-JSON REWRITE
The dashboard has zero panels. The panels field is null/empty so patch operations CANNOT work here.
You MUST use a full-JSON update_dashboard call with the complete panels array:
  {
    "dashboard": {
      "title": "<descriptive title>",
      "description": "<description>",
      "uid": "${dashboardUid}",
      "panels": [ /* ALL row panels AND data panels here */ ],
      "schemaVersion": 38,
      "time": { "from": "now-1h", "to": "now" },
      "timepicker": {}, "refresh": "30s", "tags": [],
      "templating": { "list": [] }, "annotations": { "list": [] }
    },
    "folderUid": "",
    "overwrite": true
  }
DO NOT use patch operations (uid+operations) — they will silently fail on a null panels array.
Build ALL panels in this single call.` :
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
function parsePlanResponse(content: string): { panels: any[]; variables: any[]; timeRange: any; layoutHint?: string } | null {
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

        // ═══════════════════════════════════════════════════════════════════
        // PHASE 2 — CREATE
        // Build and write the complete dashboard in one update_dashboard call.
        // Gate: update_dashboard succeeded and UID extracted.
        // Retry up to 2 times on error.
        // ═══════════════════════════════════════════════════════════════════

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

                // REPAIR — give the LLM the gap report and the original findings
                const repairPrompt = buildRepairPhasePrompt(
                    gaps, createdDashboardUid,
                    enrichedFindings, schemaRules(), context,
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
