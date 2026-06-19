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

const SETTINGS_PATH = '/plugins/vikshana-graft-app';

/** findLastIndex polyfill — Array.prototype.findLastIndex requires ES2023 */
function findLastIndex<T>(arr: T[], predicate: (item: T) => boolean): number {
    for (let i = arr.length - 1; i >= 0; i--) {
        if (predicate(arr[i])) { return i; }
    }
    return -1;
}

/**
 * Tools available to the dashboard agent.
 * Explicitly limited to dashboards + datasources — it never queries data directly.
 */
const DASHBOARD_TOOL_CATEGORIES = ['dashboards', 'datasources'];

function scopeDashboardTools(allTools: any[]): any[] {
    const allowed = new Set<string>();
    for (const cat of DASHBOARD_TOOL_CATEGORIES) {
        const catKey = cat as keyof typeof TOOL_CATEGORIES;
        if (TOOL_CATEGORIES[catKey]) {
            for (const tool of TOOL_CATEGORIES[catKey]) {
                allowed.add(tool);
            }
        }
    }
    return allTools.filter(t => allowed.has(t.function?.name));
}

// ─── Findings formatter ───────────────────────────────────────────────────────

/** Render a thresholds array as compact JSON for the prompt. */
function renderThresholds(thresholds: PanelThreshold[]): string {
    return JSON.stringify(thresholds.map(t => ({ value: t.value, color: t.color })));
}

/**
 * Formats DataFindings into a structured block for the dashboard agent's system prompt.
 * Now includes presentation metadata (unit, suggestedViz, metricType, thresholds)
 * and the full labels map for template variable generation.
 */
function formatFindingsForPrompt(dataFindings: DataFindings): string {
    const sections: string[] = [];

    if (dataFindings.loki) {
        const f = dataFindings.loki;
        const dsJson = `{"type": "loki", "uid": "${f.datasourceUid}"}`;

        // Render labels for variable generation
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
        datasourceDirective = `IMPORTANT — the conversation context indicates this dashboard should visualize
**Prometheus metrics**. You MUST:
1. Call list_datasources and select a datasource of type **"prometheus"**.
2. Write **PromQL** expressions (metric names, rate(), sum(), histogram_quantile(), etc.) for all panels.
3. Do NOT build a logs dashboard or use a Loki datasource — this is a metrics dashboard.`;
    } else if (onlyLoki) {
        datasourceDirective = `IMPORTANT — the conversation context indicates this dashboard should visualize
**Loki logs**. You MUST:
1. Call list_datasources and select a datasource of type **"loki"**.
2. Write **LogQL** expressions ({} stream selectors, |= filters, log_range_vector) for all panels.
3. Do NOT build a metrics dashboard or use a Prometheus datasource — this is a logs dashboard.`;
    } else {
        datasourceDirective = `Select the datasource by TYPE according to the query language you will write:
   - Log panels / LogQL ({} stream selectors) → a datasource of type "loki".
   - Metric panels / PromQL (rate(), sum(), metric names) → a datasource of type "prometheus".`;
    }

    return `## No pre-validated queries were provided

You have NO pre-validated queries from upstream agents. You MUST determine the correct datasource
yourself before writing any panel — do not guess a UID and do not reuse a datasource of the wrong type.

Mandatory steps before building data panels:
1. Call list_datasources to see the available datasources and their types.
2. ${datasourceDirective}
3. Use that datasource's exact uid and type in every target: { "type": "<loki|prometheus>", "uid": "<uid>" }.

NEVER attach a LogQL query to a prometheus datasource, and NEVER attach a PromQL query to a loki
datasource — that is the single most common cause of an empty "No data" dashboard.`;
}

// ─── V1 quality rules ─────────────────────────────────────────────────────────

function buildV1DashboardRules(layoutHint?: string): string {
    // Derive row grouping strategy from layout hint
    const rowStrategy = layoutHint === 'RED'
        ? `Organize panels into rows by signal type:
  - Row "Request Rate" — request/throughput timeseries panels (full width or paired)
  - Row "Errors" — error rate / error count panels
  - Row "Duration / Latency" — latency timeseries and histogram quantile panels
  - Row "Logs" (if applicable) — log panels at the bottom`
        : layoutHint === 'USE'
        ? `Organize panels into rows by resource:
  - One row per resource type (CPU, Memory, Network, Disk)
  - Within each row: Utilization | Saturation | Errors`
        : layoutHint === 'golden-signals'
        ? `Organize panels into rows by signal:
  - Row "Latency", Row "Traffic", Row "Errors", Row "Saturation"`
        : `Group related panels into rows. Create one row per logical service, component, or signal type.
  Each row should have a descriptive title. Related panels (e.g. request rate + error rate for the same service)
  belong in the same row.`;

    return `## Dashboard schema: Classic v1 (panels[]/templating.list)

## Dashboard skeleton (Step 1 — create this first)
Call update_dashboard with this skeleton. Choose a time range appropriate to the data:
{
  "dashboard": {
    "title": "<descriptive title reflecting the service/scope being monitored>",
    "description": "<1-2 sentence description of what this dashboard monitors>",
    "uid": "",
    "id": null,
    "panels": [],
    "schemaVersion": 38,
    "time": { "from": "now-1h", "to": "now" },
    "timepicker": {},
    "refresh": "30s",
    "tags": ["<service-name>", "<env>"],
    "templating": { "list": [] },
    "annotations": { "list": [] }
  },
  "folderId": 0,
  "overwrite": false
}

## Step 2 — Get assigned UID
Call get_dashboard_by_uid with the uid returned by update_dashboard.
Also read isV2 from the response — if true, you are on a V2-capable Grafana and
could use the v2 schema for future dashboards, but continue with v1 for this one.
IMPORTANT: note the UID immediately and include [Open dashboard](/d/{uid}) in your final response.

## Step 3 — Build template variables FIRST (before panels)
If labels were provided in the findings above, create query variables in templating.list.
For each meaningful label (e.g. job, instance, namespace, service):
{
  "name": "<label_name>",
  "type": "query",
  "label": "<Human Label>",
  "datasource": { "type": "<loki|prometheus>", "uid": "<datasourceUid>" },
  "query": "label_values(<metric_or_stream>, <label_name>)",
  "refresh": 2,
  "includeAll": true,
  "multi": true,
  "allValue": ".*",
  "sort": 1
}
Then update panel queries to use the variable: replace fixed label values with $<label_name>
and use \${<label_name>:regex} inside regex matchers or LogQL stream selectors.

## Step 4 — Build ALL panels in a single update
Build the complete panels array including all row panels and data panels, then call update_dashboard
ONCE with the full dashboard JSON. Do NOT call get_dashboard_by_uid before each panel.

${rowStrategy}

## Panel construction rules

### Row panels (create one per logical group BEFORE the group's data panels)
{ "type": "row", "title": "<Row Title>", "id": <id>, "collapsed": false,
  "gridPos": { "h": 1, "w": 24, "x": 0, "y": <y> }, "panels": [] }

### Panel layout (24-column grid)
- Stats row at top: w:6, h:4 per panel (fits 4 across)
- Log panels: w:24, h:8 (full width — logs need space)
- Paired panels (e.g. rate + errors): w:12, h:8 each, x:0 and x:12
- Single timeseries: w:24, h:8 (full width) or w:12 paired
- Heatmaps: w:12 or w:24, h:8
- Always increment y to place each panel/row below the previous one
- Never overlap: ensure y + h of one panel = y of the next at the same x

### Visualization type selection
Use "suggestedViz" from the presentation metadata above. If not provided:
- "timeseries" for time-varying metrics (rates, counts over time)
- "stat" for single current values (uptime, version, current error count)
- "gauge" for bounded ratios/percentages (0–1 or 0–100)
- "bargauge" for comparing values across labels (per-service breakdown)
- "heatmap" for histogram _bucket metrics — set dataFormat:"tsbuckets", yAxis.unit, and use "le" as the legend
- "table" for multi-column label breakdowns
- "logs" for raw Loki log streams — set options.dedupStrategy="none", options.showTime=true
- "timeseries" for LogQL metric queries (rate(), count_over_time(), etc.)

### Units (fieldConfig.defaults.unit)
REQUIRED on every data panel. Use the "unit" from presentation metadata above. If not provided:
- "s" for _seconds/_duration metrics
- "ms" for _milliseconds metrics
- "bytes" for _bytes metrics
- "percent" for 0–100 percentage metrics, "percentunit" for 0–1 ratios
- "reqps" for rate() on _total/_count metrics
- "short" for dimensionless counts / generic numbers
Set on the panel as: "fieldConfig": { "defaults": { "unit": "<unit>" } }

### Thresholds (stat/gauge/bargauge panels)
REQUIRED for stat, gauge, and bargauge panels. Use the "thresholds" from presentation metadata if provided.
Default: green (base) → orange (80%) → red (90%). Encode as:
"fieldConfig": {
  "defaults": {
    "unit": "<unit>",
    "thresholds": {
      "mode": "absolute",
      "steps": [{"value": null, "color": "green"}, {"value": 80, "color": "orange"}, {"value": 90, "color": "red"}]
    },
    "color": { "mode": "thresholds" }
  }
}
For error rates (0–1): steps null→green, 0.01→orange, 0.05→red
For utilization (0–1): steps null→green, 0.75→orange, 0.90→red

### Panel descriptions
REQUIRED on every panel. Set "description": "<what this panel shows and why it matters>".
This appears as a tooltip (ⓘ) when the user hovers the panel title.

### Legend format (required on every target)
- Loki: use label matchers from the expr, e.g. "{{job}} {{level}}". Static string if no labels.
- Prometheus: use label names from PromQL, e.g. "{{job}}" or "{{instance}}". Static if scalar.
- Never omit legendFormat. Never use "" or "{{__name__}}".

### Datasource correctness
CRITICAL: LogQL → loki datasource. PromQL → prometheus datasource. Never cross them.

## Step 5 — Verify
Call get_dashboard_by_uid. Confirm panel count and that rows are present.
Then call get_dashboard_panel_queries and fix any datasource-type mismatch before finishing.

## Step 6 — Quality self-audit
Call get_dashboard_summary and verify:
- Every data panel has a unit set (not empty)
- stat/gauge/bargauge panels have thresholds
- Every panel has a description
- Row panels are present grouping the data panels
If any panel fails a check and the iteration budget allows, call update_dashboard to patch it.

## Final response
Include:
- Dashboard title and [Open dashboard](/d/{uid})
- Panels created with their titles, visualization types, and queries
- Template variables added (if any)
- Any datasource mismatches found and corrected
- Any quality issues patched`;
}

// ─── V2 quality rules (dormant — requires mcp-grafana ≥ v0.16.0) ─────────────

function buildV2DashboardRules(layoutHint?: string): string {
    const tabStrategy = layoutHint === 'RED'
        ? `Create tabs for: "Request Rate", "Errors", "Duration", and (if applicable) "Logs".`
        : layoutHint === 'USE'
        ? `Create one tab per resource type (CPU, Memory, Network, Disk).`
        : layoutHint === 'golden-signals'
        ? `Create tabs for: "Latency", "Traffic", "Errors", "Saturation".`
        : `Create one tab per logical service or signal type. Group related panels within each tab.`;

    return `## Dashboard schema: V2 (elements/layout/variables)
NOTE: This Grafana supports the V2 dashboard schema (app-platform API).
The update_dashboard tool will route V2 bodies (those with top-level "elements"/"layout") through
the Kubernetes API. If the write fails with "Kubernetes-capable Grafana is required", fall back
to the Classic v1 schema immediately (rebuild with panels[] instead of elements/layout).

## V2 Structure
V2 dashboards use a fundamentally different shape from v1:
- Panels live in "elements" — a map keyed by element name, NOT a panels[] array
- "layout" references elements and defines tabs/rows/grid positioning
- Variables in "variables[]" (not "templating.list")
- Time range in "timeSettings" (not "time"/"refresh")

## V2 Skeleton (Step 1)
Call update_dashboard with this body (top-level "elements"/"layout" signals V2 to the MCP server):
{
  "dashboard": {
    "title": "<descriptive title>",
    "description": "<what this dashboard monitors>",
    "tags": ["<service>"],
    "elements": {},
    "layout": {
      "kind": "TabsLayout",
      "spec": { "tabs": [] }
    },
    "variables": [],
    "timeSettings": { "from": "now-1h", "to": "now", "autoRefresh": "30s" }
  },
  "overwrite": false
}

## Step 2 — Build variables
For each meaningful label add to "variables":
{
  "kind": "QueryVariable",
  "spec": {
    "name": "<label>",
    "label": "<Human Label>",
    "query": "label_values(<metric>, <label>)",
    "datasource": { "type": "<prometheus|loki>", "uid": "<uid>" },
    "includeAll": true,
    "multi": true,
    "allValue": ".*",
    "refresh": "onDashboardLoad"
  }
}

## Step 3 — Build panels in elements map
Each panel is a named entry in "elements":
"elements": {
  "<panel-name>": {
    "kind": "Panel",
    "spec": {
      "id": <sequential int>,
      "title": "<Panel Title>",
      "description": "<what this panel shows>",
      "vizConfig": {
        "kind": "<TimeSeriesPanel|StatPanel|GaugePanelcfg|BarGaugePanel|HeatmapPanel|TablePanel|LogsPanel>",
        "spec": {
          "fieldConfig": {
            "defaults": {
              "unit": "<unit>",
              "thresholds": { "mode": "absolute", "steps": [{"value": null, "color": "green"}, ...] },
              "color": { "mode": "thresholds" }
            }
          }
        }
      },
      "data": {
        "kind": "QueryGroup",
        "spec": {
          "queries": [
            {
              "kind": "PanelQuery",
              "spec": {
                "refId": "A",
                "query": {
                  "kind": "prometheus",
                  "group": "prometheus",
                  "datasource": { "name": "<datasourceUid>" },
                  "spec": { "expr": "<PromQL or LogQL expression>", "legendFormat": "{{job}}" }
                }
              }
            }
          ]
        }
      }
    }
  }
}
NOTE: datasource type is "group" (the datasource plugin id), uid goes in "datasource.name" (V2 convention).

## Step 4 — Build layout with tabs
${tabStrategy}

"layout": {
  "kind": "TabsLayout",
  "spec": {
    "tabs": [
      {
        "kind": "TabsLayoutTab",
        "spec": {
          "title": "<Tab Title>",
          "layout": {
            "kind": "GridLayout",
            "spec": {
              "items": [
                {
                  "kind": "GridLayoutItem",
                  "spec": {
                    "x": 0, "y": 0, "width": 12, "height": 8,
                    "element": { "kind": "ElementReference", "name": "<panel-name>" }
                  }
                }
              ]
            }
          }
        }
      }
    ]
  }
}

## Quality rules (same as v1)
- Unit on every data panel (fieldConfig.defaults.unit)
- Thresholds on stat/gauge panels
- Description on every panel
- Variable queries with includeAll
- Correct datasource grouping per query language

## Fallback
If update_dashboard fails with "Kubernetes-capable Grafana is required" or "k8s client is not available",
the V2 schema cannot be saved on this Grafana. Immediately rebuild the dashboard using the Classic v1
schema (panels[], templating.list, time/refresh) and call update_dashboard again.`;
}

// ─── Main system prompt builder ───────────────────────────────────────────────

function buildDashboardSystemPrompt(
    stepDescription: string,
    dataFindings: DataFindings,
    context: string,
    preferredCategories: ToolCategory[] = [],
    conversationDigest = '',
    schemaCapability: DashboardSchemaCapability = 'v1',
): string {
    const findingsBlock = formatFindingsForPrompt(dataFindings);
    const hasFindings = findingsBlock.length > 0;
    const hasValidatedQueries =
        hasFindings &&
        ((dataFindings.loki?.validatedQueries?.length ?? 0) > 0 ||
            (dataFindings.prometheus?.validatedQueries?.length ?? 0) > 0);
    const hasKnownDatasource = hasFindings && !hasValidatedQueries;

    const layoutHint = dataFindings.layoutHint;
    const schemaRules = schemaCapability === 'v2-capable'
        ? buildV2DashboardRules(layoutHint)
        : buildV1DashboardRules(layoutHint);

    return `You are a dashboard construction agent for Graft, an AI assistant embedded in Grafana.
Your task: ${stepDescription}

You have access to dashboard and datasource tools ONLY. You do NOT have query tools.
Do not attempt to call query_loki_logs, query_prometheus, or any list_loki/list_prometheus tools.
All queries have been pre-validated by upstream agents — use them exactly as provided.

${conversationDigest ? `## Recent conversation (use to resolve references like "it", "that service")
${conversationDigest}

` : ''}${hasValidatedQueries ? `## Pre-validated data from upstream agents

${findingsBlock}

These queries have already been confirmed to return data. Copy them verbatim into panel targets.
Do NOT modify, paraphrase, or reconstruct them.` : hasKnownDatasource ? `## Datasource identified — no pre-validated queries

The upstream specialist identified the correct datasource but all candidate queries were filtered
out (they returned no data during validation). Use the datasource below but write your own queries.

${findingsBlock}

${buildEmptyFindingsGuidance(preferredCategories)}` : buildEmptyFindingsGuidance(preferredCategories)}

${schemaRules}

${context ? `## Current Grafana context\n${context}` : ''}`;
}

// ─── UID extraction helper ────────────────────────────────────────────────────

function extractDashboardUid(rawResult: string): string | undefined {
    try {
        const parsed = JSON.parse(rawResult);
        const blocks: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
        for (const block of blocks) {
            if (typeof block !== 'object' || block === null) { continue; }
            const b = block as Record<string, unknown>;
            if (typeof b['uid'] === 'string' && b['uid']) { return b['uid'] as string; }
            if (typeof b['text'] === 'string') {
                try {
                    const inner = JSON.parse(b['text'] as string) as Record<string, unknown>;
                    if (typeof inner['uid'] === 'string' && inner['uid']) { return inner['uid'] as string; }
                } catch { /* not JSON */ }
            }
        }
    } catch { /* not parseable */ }
    return undefined;
}

// ─── isV2 probe ───────────────────────────────────────────────────────────────

/**
 * Reads isV2/apiVersion from a get_dashboard_by_uid tool result.
 * Returns the resolved target schema: 'v2' if the server confirmed V2 capability,
 * 'v1' otherwise. Used for the authoritative capability probe after skeleton creation.
 */
function resolveSchemaFromProbeResult(rawResult: string, heuristic: DashboardSchemaCapability): DashboardSchemaCapability {
    try {
        const parsed = JSON.parse(rawResult);
        // get_dashboard_by_uid returns { dashboard, meta, apiVersion, isV2 }
        // (mcp-grafana ≥ v0.16.0). On older servers this key is absent → v1.
        const blocks: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
        for (const block of blocks) {
            if (typeof block !== 'object' || block === null) { continue; }
            const b = block as Record<string, unknown>;
            // Try direct isV2 field (v0.16.0+)
            if (typeof b['isV2'] === 'boolean') {
                // isV2 on the response means the server can handle V2;
                // if heuristic says v2-capable, use v2
                return heuristic === 'v2-capable' ? 'v2-capable' : 'v1';
            }
            // Try text-block JSON (content array wrapping)
            if (typeof b['text'] === 'string') {
                try {
                    const inner = JSON.parse(b['text'] as string) as Record<string, unknown>;
                    if (typeof inner['isV2'] === 'boolean') {
                        return heuristic === 'v2-capable' ? 'v2-capable' : 'v1';
                    }
                } catch { /* not JSON */ }
            }
        }
    } catch { /* not parseable */ }
    // No isV2 field → old server (v0.11.4) → v1 only
    return 'v1';
}

// ─── Main agent entry point ───────────────────────────────────────────────────

/**
 * Purpose-built dashboard creation/editing agent.
 *
 * Key behaviours:
 * - Uses Model.LARGE for robust dashboard JSON construction
 * - Tool scope limited to dashboards + datasources (never queries data directly)
 * - Enriches DataFindings with deterministic unit/viz/threshold metadata before prompting
 * - Builds a v1 (Classic) or v2 (elements/layout/tabs) dashboard based on runtime capability
 * - Performs an authoritative V2 capability probe after skeleton creation (reads isV2 from
 *   get_dashboard_by_uid response). On v0.11.4 servers the field is absent → always v1.
 * - V2 write failures fall back to v1 automatically
 * - Dashboard JSON results are never compressed (required for correct panel construction)
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
    // Apply deterministic enrichment before building the prompt
    const enrichedFindings = enrichDataFindings(dataFindings, step.description, userMessage);

    const scopedTools = scopeDashboardTools(allTools);

    // Start with the heuristic schema target; will be refined by the runtime probe
    let resolvedSchema: DashboardSchemaCapability = schemaCapabilityHint;

    const systemPrompt = buildDashboardSystemPrompt(
        step.description, enrichedFindings, context,
        preferredCategories, conversationDigest, resolvedSchema,
    );

    const llmMessages: any[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
    ];

    const toolExecutions: ToolExecution[] = [];
    let fullContent = '';
    let iteration = 0;
    let createdDashboardUid: string | undefined;
    let v2FallbackNote = '';

    // Dashboard JSON results must never be compressed — the agent needs the full
    // panel/elements structure for each update.
    const NO_COMPRESS = new Set([
        'get_dashboard_by_uid',
        'get_dashboard_panel_queries',
        'get_dashboard_property',
        'get_dashboard_summary',
        'update_dashboard',
    ]);

    try {
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

            llmMessages.push({
                role: 'assistant',
                content: fullContent,
                tool_calls: toolCalls,
            });

            for (const toolCall of toolCalls) {
                if (signal.aborted) { throw new Error('Aborted'); }

                toolExecutions.push({ name: toolCall.function.name, status: 'pending' });
                onUpdate(step.id, toolExecutions.map(t => ({ ...t })));

                let rawResult = '';
                try {
                    if (!mcpClient) { throw new Error('MCP client not available'); }

                    const args = normalizeToolArgs(JSON.parse(toolCall.function.arguments));
                    const result = await mcpClient.callTool({ name: toolCall.function.name, arguments: args });
                    rawResult = JSON.stringify(result.content);

                    // ── UID extraction ──────────────────────────────────────
                    if (toolCall.function.name === 'update_dashboard' && !createdDashboardUid) {
                        createdDashboardUid = extractDashboardUid(rawResult);
                    }

                    // ── Authoritative V2 capability probe ───────────────────
                    // After the skeleton's get_dashboard_by_uid call, read isV2 from the
                    // response. On mcp-grafana ≥ v0.16.0 this confirms V2 capability;
                    // on v0.11.4 (current bundled) the field is absent → resolves to v1.
                    if (toolCall.function.name === 'get_dashboard_by_uid' && createdDashboardUid) {
                        const probed = resolveSchemaFromProbeResult(rawResult, schemaCapabilityHint);
                        if (probed !== resolvedSchema) {
                            resolvedSchema = probed;
                            // Rebuild system prompt with confirmed target (affects remaining iterations)
                            const updatedPrompt = buildDashboardSystemPrompt(
                                step.description, enrichedFindings, context,
                                preferredCategories, conversationDigest, resolvedSchema,
                            );
                            llmMessages[0] = { role: 'system', content: updatedPrompt };
                        }
                    }

                    // ── V2 write failure → fall back to v1 ─────────────────
                    if (toolCall.function.name === 'update_dashboard' &&
                        resolvedSchema === 'v2-capable' &&
                        (rawResult.includes('Kubernetes-capable Grafana is required') ||
                         rawResult.includes('k8s client is not available'))) {
                        resolvedSchema = 'v1';
                        v2FallbackNote = '\n\n> **Note:** V2 schema write failed (app-platform API not available on this Grafana). Dashboard rebuilt as Classic v1.';
                        const updatedPrompt = buildDashboardSystemPrompt(
                            step.description, enrichedFindings, context,
                            preferredCategories, conversationDigest, 'v1',
                        );
                        llmMessages[0] = { role: 'system', content: updatedPrompt };
                    }

                    llmMessages.push({
                        role: 'tool',
                        content: rawResult,
                        tool_call_id: toolCall.id,
                    });

                    const idx = findLastIndex(
                        toolExecutions,
                        (t: ToolExecution) => t.name === toolCall.function.name && t.status === 'pending'
                    );
                    if (idx !== -1) { toolExecutions[idx].status = 'success'; }
                } catch (err: any) {
                    rawResult = `Error: ${err.message}`;
                    llmMessages.push({
                        role: 'tool',
                        content: rawResult,
                        tool_call_id: toolCall.id,
                    });
                    const idx = findLastIndex(
                        toolExecutions,
                        (t: ToolExecution) => t.name === toolCall.function.name && t.status === 'pending'
                    );
                    if (idx !== -1) {
                        toolExecutions[idx].status = 'error';
                        toolExecutions[idx].error = err.message;
                    }
                }

                onUpdate(step.id, toolExecutions.map(t => ({ ...t })));
            }

            // Compress only non-dashboard tool results (list_datasources etc.)
            for (const toolCall of toolCalls) {
                if (NO_COMPRESS.has(toolCall.function.name)) { continue; }
                const msgIdx = findLastIndex(
                    llmMessages,
                    (m: any) => m.role === 'tool' && m.tool_call_id === toolCall.id
                );
                if (msgIdx !== -1) {
                    const original = llmMessages[msgIdx].content;
                    const preview = original.length > 300 ? original.slice(0, 300) + '...' : original;
                    llmMessages[msgIdx] = {
                        ...llmMessages[msgIdx],
                        content: `[${toolCall.function.name} result processed — summary: ${preview}]`,
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

        if (iteration >= maxIterations) {
            const uidHint = createdDashboardUid
                ? `[Open dashboard](/d/${createdDashboardUid})`
                : 'check the tool calls above for its UID and open it at /d/{uid}';
            fullContent += `\n\n> **Note:** Maximum tool call steps (${maxIterations}) reached. If the dashboard was created, ${uidHint}. To add remaining panels, ask me to continue, or increase the limit in the Graft plugin settings at ${SETTINGS_PATH}.`;
        }

        if (v2FallbackNote) {
            fullContent += v2FallbackNote;
        }

        return {
            stepId: step.id,
            status: 'success',
            summary: fullContent || `Dashboard step "${step.description}" completed with ${toolExecutions.length} tool call(s).`,
            toolExecutions,
            dashboardUid: createdDashboardUid,
        };
    } catch (err: any) {
        if (err.message === 'Aborted') { throw err; }
        return {
            stepId: step.id,
            status: 'error',
            summary: `Dashboard step "${step.description}" failed.`,
            error: err.message,
            toolExecutions,
        };
    }
}
