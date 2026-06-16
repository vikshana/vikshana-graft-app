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

export interface ValidatedLokiQuery {
    description: string;
    logql: string;
}

export interface ValidatedPrometheusQuery {
    description: string;
    promql: string;
}

/**
 * Structured findings produced by a Loki specialist step.
 * Contains the datasource UID and pre-validated LogQL expressions.
 */
export interface LokiFindings {
    datasourceUid: string;
    datasourceName: string;
    /** Discovered label names and a sample of their values */
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
    /** Queries that have been executed and confirmed to return data */
    validatedQueries: ValidatedPrometheusQuery[];
}

/**
 * Aggregated data findings passed from upstream specialists to the dashboard agent.
 */
export interface DataFindings {
    loki?: LokiFindings;
    prometheus?: PrometheusFindings;
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
}

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
}
