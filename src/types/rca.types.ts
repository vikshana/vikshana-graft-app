/**
 * TypeScript types for the ORCA interactive RCA feature.
 *
 * These mirror the Pydantic schemas in
 * services/orca/backend/app/schemas/rca_session.py
 * and the SQLAlchemy models in app/models/.
 */

// ---------------------------------------------------------------------------
// Shared sub-types
// ---------------------------------------------------------------------------

export interface AlertContextInput {
  alert_name: string;
  description: string;
  service?: string;
  environment?: string;
  labels: Record<string, string>;
}

export interface Hypothesis {
  text: string;
  high_confidence_areas: string[];
  uncertain_areas: string[];
  suggested_questions: string[];
}

export interface QATurn {
  role: 'developer' | 'agent';
  content: string;
}

// ---------------------------------------------------------------------------
// SSE stream event types (emitted by /start and /refine)
// ---------------------------------------------------------------------------

export type RCAStreamEventType =
  | 'session_created'
  | 'step'
  | 'hypothesis'
  | 'tool_call'
  | 'tool_result'
  | 'interrupt'
  | 'done'
  | 'error';

export interface SessionCreatedEvent {
  type: 'session_created';
  thread_id: string;
}

export interface StepEvent {
  type: 'step';
  node: string;
  status: 'started' | 'complete';
}

export interface HypothesisEvent {
  type: 'hypothesis';
  hypothesis: Hypothesis;
  confidence: number;
}

export interface ToolCallEvent {
  type: 'tool_call';
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolResultEvent {
  type: 'tool_result';
  tool: string;
  result_preview: string;
}

export interface InterruptEvent {
  type: 'interrupt';
  thread_id: string;
  hypothesis: Hypothesis | null;
  confidence: number;
  round: number;
  suggested_questions: string[];
}

export interface DoneEvent {
  type: 'done';
  reason: 'awaiting_input' | 'complete';
}

export interface ErrorEvent {
  type: 'error';
  message: string;
}

export type RCAStreamEvent =
  | SessionCreatedEvent
  | StepEvent
  | HypothesisEvent
  | ToolCallEvent
  | ToolResultEvent
  | InterruptEvent
  | DoneEvent
  | ErrorEvent;

// ---------------------------------------------------------------------------
// API request / response types
// ---------------------------------------------------------------------------

export interface RCAStartRequest {
  alert_id?: string;
  alert_context: AlertContextInput;
}

export interface RCARefineRequest {
  message: string;
}

export interface RCAAcceptResponse {
  thread_id: string;
  rca_session_id: string | null;
  final_report: Record<string, unknown> | null;
  developer_override: boolean;
}

export interface RCAHistoryResponse {
  thread_id: string;
  round: number;
  hypotheses: Hypothesis[];
  confidence_scores: number[];
  qa_transcript: QATurn[];
  final_report: Record<string, unknown> | null;
  rca_session_id: string | null;
  developer_accepted: boolean;
  force_finalized: boolean;
}

export interface RCASearchResult {
  rca_session_id: string;
  alert_type: string | null;
  service: string | null;
  final_hypothesis: string | null;
  final_confidence: number | null;
  accepted_at: string | null;
  similarity: number;
}

export interface RCASearchResponse {
  query: string;
  results: RCASearchResult[];
}

// ---------------------------------------------------------------------------
// Legacy RCA list types (from existing GET /api/rca endpoint)
// ---------------------------------------------------------------------------

export interface RCASummary {
  id: string;
  alert_name: string;
  status: string;
  confidence_level: string | null;
  service_name: string | null;
  deployment_environment_name: string | null;
  created_at: string;
  completed_at: string | null;
  duration_seconds: number | null;
}

export interface RCAListResponse {
  items: RCASummary[];
  total: number;
  page: number;
  page_size: number;
}

// ---------------------------------------------------------------------------
// Dashboard stats types (from GET /api/stats)
// ---------------------------------------------------------------------------

export interface ConfidenceBreakdown {
  high: number;
  medium: number;
  low: number;
  unset: number;
}

export interface StatusBreakdown {
  triggered: number;
  investigating: number;
  complete: number;
  failed: number;
}

export interface DashboardStats {
  total_runs: number;
  completed_runs: number;
  failed_runs: number;
  investigating_runs: number;
  success_rate: number;
  avg_duration_seconds: number | null;
  confidence_breakdown: ConfidenceBreakdown;
  status_breakdown: StatusBreakdown;
  recent_anomalies: RCASummary[];
}

// ---------------------------------------------------------------------------
// UI state machine for the investigate page
// ---------------------------------------------------------------------------

export type RCAInvestigateStatus =
  | 'idle'
  | 'starting'
  | 'awaiting_input'
  | 'refining'
  | 'accepting'
  | 'complete'
  | 'failed';
