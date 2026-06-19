import type { ToolExecution } from '../../types/llm.types';

export type ToolCategory = 'loki' | 'prometheus' | 'dashboards' | 'datasources';

/**
 * A single step in an agent plan.
 */
export interface PlanStep {
    /** Unique identifier within this plan, e.g. "step_1" */
    id: string;
    /** Human-readable description shown to the user */
    description: string;
    /** Which MCP tool categories this step is allowed to use */
    toolCategories: ToolCategory[];
    /** IDs of steps that must complete before this step can start */
    dependsOn: string[];
}

/**
 * Structured plan produced by the Planner agent.
 */
export interface AgentPlan {
    /**
     * 'simple' → single-agent fallback (existing llmService.chat loop).
     * 'complex' → full multi-agent pipeline.
     */
    complexity: 'simple' | 'complex';
    steps: PlanStep[];
    /** Brief reasoning shown to the user as a plan summary */
    reasoning: string;
}

// ─── Data findings ────────────────────────────────────────────────────────────
// Structured output produced by Loki/Prometheus specialists and consumed by the
// dashboard agent. Kept separate from the prose summary so each consumer gets
// exactly the format it needs.

/**
 * Grafana fieldConfig unit id for a metric — e.g. "s", "bytes", "percent",
 * "reqps", "short". Drives fieldConfig.defaults.unit in the generated panel.
 */
export type PanelUnit =
    | 's' | 'ms' | 'ns'              // duration
    | 'bytes' | 'decbytes'            // data size
    | 'Bps' | 'decBps'               // throughput
    | 'percent' | 'percentunit'       // ratios
    | 'reqps' | 'wps' | 'rps'        // rates
    | 'short' | 'none'               // dimensionless
    | string;                        // any other valid Grafana unit id

/**
 * The Prometheus metric type — informs visualization and threshold choices.
 */
export type MetricType = 'counter' | 'gauge' | 'histogram' | 'summary';

/**
 * Suggested Grafana visualization type for a query.
 */
export type SuggestedViz =
    | 'timeseries'
    | 'stat'
    | 'gauge'
    | 'bargauge'
    | 'table'
    | 'heatmap'
    | 'logs';

/**
 * A single threshold step for stat/gauge panels.
 * Matches Grafana's threshold object shape.
 */
export interface PanelThreshold {
    value: number | null;  // null = the "base" threshold (lowest)
    color: string;         // Grafana color name or hex, e.g. "green", "orange", "red"
}

/**
 * Per-query presentation metadata produced by the specialist and consumed by
 * the dashboard agent. All fields are optional — the dashboard enrichment
 * layer fills any gaps via deterministic metric-name pattern matching.
 */
export interface QueryPresentationMeta {
    /** Grafana fieldConfig unit id — drives axis labels and value display */
    unit?: PanelUnit;
    /** Prometheus metric type — informs viz choice (histogram→heatmap, gauge→stat) */
    metricType?: MetricType;
    /** Suggested visualization plugin — overrides the default timeseries */
    suggestedViz?: SuggestedViz;
    /** Threshold steps for stat/gauge panels (ascending value order, base first) */
    thresholds?: PanelThreshold[];
}

export interface ValidatedLokiQuery extends QueryPresentationMeta {
    description: string;
    logql: string;
}

export interface ValidatedPrometheusQuery extends QueryPresentationMeta {
    description: string;
    promql: string;
}

/**
 * Layout/organization hint produced by the specialist or inferred from the
 * step description. Drives row grouping (v1) and tab layout (v2).
 */
export type LayoutHint = 'RED' | 'USE' | 'golden-signals' | 'none';

/**
 * Structured findings produced by a Loki specialist step.
 * Contains the datasource UID and pre-validated LogQL expressions.
 */
export interface LokiFindings {
    datasourceUid: string;
    datasourceName: string;
    /** Discovered label names and a sample of their values — used for template variables */
    labels: Record<string, string[]>;
    /** Queries that have been executed and confirmed to return data */
    validatedQueries: ValidatedLokiQuery[];
}

/**
 * Structured findings produced by a Prometheus specialist step.
 */
export interface PrometheusFindings {
    datasourceUid: string;
    datasourceName: string;
    /** Discovered label names and a sample of their values — used for template variables */
    labels: Record<string, string[]>;
    /** Queries that have been executed and confirmed to return data */
    validatedQueries: ValidatedPrometheusQuery[];
}

/**
 * Aggregated data findings passed from upstream specialists to the dashboard agent.
 */
export interface DataFindings {
    loki?: LokiFindings;
    prometheus?: PrometheusFindings;
    /**
     * Observability-method hint for the dashboard layout.
     * Drives row grouping (v1) and tab layout (v2).
     * Inferred from step description / conversation if not set by the specialist.
     */
    layoutHint?: LayoutHint;
}

// ─── Specialist result ────────────────────────────────────────────────────────

/**
 * Result returned by a Specialist agent after completing its step.
 */
export interface SpecialistResult {
    stepId: string;
    status: 'success' | 'error';
    /** Prose summary — consumed by the Synthesiser for the final user response */
    summary: string;
    error?: string;
    /** Final snapshot of all tool executions made during this step */
    toolExecutions: ToolExecution[];
    /**
     * Structured findings — only set by Loki/Prometheus data steps.
     * Consumed by the dashboard agent to build panels with pre-validated queries.
     */
    dataFindings?: DataFindings;
    /**
     * UID of the Grafana dashboard created or updated during this step.
     * Set by the dashboard agent when update_dashboard succeeds.
     * Used by the synthesiser to guarantee a clickable link in the final response.
     */
    dashboardUid?: string;
}

// ─── Dashboard schema capability ─────────────────────────────────────────────

/**
 * Dashboard schema capability detected at runtime.
 *   'v1'          — Classic panels[]/templating.list schema (always supported)
 *   'v2-capable'  — Grafana ≥ 12 with the dashboard.grafana.app API available;
 *                   elements/layout/variables schema may be used.
 */
export type DashboardSchemaCapability = 'v1' | 'v2-capable';

// ─── Orchestration events ─────────────────────────────────────────────────────

/**
 * Progress update emitted by the Orchestrator via onUpdate callback.
 * ChatInterface handles each type to update the UI incrementally.
 */
export interface OrchestrationUpdate {
    type: 'plan' | 'step_start' | 'step_update' | 'step_done' | 'final';
    plan?: AgentPlan;
    stepId?: string;
    stepDescription?: string;
    toolExecutions?: ToolExecution[];
    content?: string;
    /** Step-level error message — set on step_done when the step threw before any tool calls */
    error?: string;
}
