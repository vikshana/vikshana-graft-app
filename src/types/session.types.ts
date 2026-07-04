/**
 * TypeScript types for the Phase 2 harness session API.
 *
 * These mirror the Python harness session models and SSE event schema.
 * The existing rca.types.ts is kept unchanged — this file covers the
 * new /api/sessions/* surface only.
 */

// ---------------------------------------------------------------------------
// Session state machine
// ---------------------------------------------------------------------------

export type SessionStatus =
  | 'idle'
  | 'running'
  | 'awaiting_input'
  | 'awaiting_approval'
  | 'paused'
  | 'complete'
  | 'failed';

export type PausedReason =
  | 'budget_exceeded'
  | 'reauth_required'
  | 'provider_unavailable'
  | 'timeout';

// ---------------------------------------------------------------------------
// SSE event types emitted by the session stream
// ---------------------------------------------------------------------------

export type SessionEventType =
  | 'session_created'
  | 'step'
  | 'hypothesis'
  | 'tool_call'
  | 'tool_result'
  | 'interrupt'
  | 'awaiting_approval'
  | 'agent_busy'
  | 'budget_exceeded'
  | 'reauth_required'
  | 'provider_unavailable'
  | 'timeout'
  | 'done'
  | 'error';

export interface SessionCreatedEvent {
  type: 'session_created';
  session_id: string;
}

export interface StepEvent {
  type: 'step';
  node: string;
  status: 'started' | 'complete';
}

export interface HypothesisEvent {
  type: 'hypothesis';
  hypothesis: { text: string; suggested_questions: string[] };
  confidence: number;
}

export interface ToolCallEvent {
  type: 'tool_call';
  tool: string;
  args: Record<string, unknown>;
  tool_call_id?: string;
  drill_down_handle?: string;
}

export interface ToolResultEvent {
  type: 'tool_result';
  tool: string;
  result_preview: string;
  truncated?: boolean;
  drill_down_handle?: string;
}

export interface InterruptEvent {
  type: 'interrupt';
  hypothesis: { text: string; suggested_questions: string[] } | null;
  confidence: number;
  round: number;
}

export interface AwaitingApprovalEvent {
  type: 'awaiting_approval';
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_call_id: string;
}

export interface AgentBusyEvent {
  type: 'agent_busy';
  session_id: string;
  queue_position: number;
}

export interface PausedEvent {
  type: PausedReason;
  message: string;
  resumable: boolean;
}

export interface DoneEvent {
  type: 'done';
  reason: 'awaiting_input' | 'complete';
}

export interface ErrorEvent {
  type: 'error';
  message: string;
}

export type SessionStreamEvent =
  | SessionCreatedEvent
  | StepEvent
  | HypothesisEvent
  | ToolCallEvent
  | ToolResultEvent
  | InterruptEvent
  | AwaitingApprovalEvent
  | AgentBusyEvent
  | PausedEvent
  | DoneEvent
  | ErrorEvent;

// ---------------------------------------------------------------------------
// API request / response types
// ---------------------------------------------------------------------------

export interface SessionListItem {
  id: string;
  type: string;
  status: string;
  alert_type?: string;
  service?: string;
  initiator_user_id?: string;
  initiator_channel?: string;
  auth_mode?: string;
  created_at?: string;
  updated_at?: string;
}

export interface SessionListResponse {
  sessions: SessionListItem[];
  total: number;
}

export interface TurnEnqueueResponse {
  job_id: string;
  is_busy: boolean;
}

export interface DrillDownResult {
  handle: string;
  tool_name: string;
  /** Full result including query_params embedded by the tool. */
  full_result: Record<string, unknown>;
  expires_at: string;
}

export interface ApproveActionRequest {
  tool_call_id: string;
  decision: 'approved' | 'denied';
}

export interface FeedbackRequest {
  score: number; // 1.0 = thumbs-up, 0.0 = thumbs-down
  comment?: string;
}

// ---------------------------------------------------------------------------
// Local UI state for a running tool call
// ---------------------------------------------------------------------------

export interface ToolCallStep {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  status: 'running' | 'done' | 'denied';
  resultPreview?: string;
  drillDownHandle?: string;
  timestamp: Date;
}
