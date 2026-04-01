/**
 * TypeScript type definitions for RCA API responses.
 * These mirror the Pydantic schemas in backend/app/schemas/rca.py.
 */

export interface AgentStep {
  id: string;
  step_number: number;
  node_name: string;
  action: string;
  input: string | null;
  output: string | null;
  tokens_used: number | null;
  duration_seconds: number | null;
  created_at: string;
}

export interface DuplicateAlertInfo {
  /** UUID of the rca_duplicate_alerts row. */
  id: string;
  /** UUID of the suppressed Alert record. */
  alert_id: string;
  /** ISO timestamp when the duplicate was recorded. */
  created_at: string;
}

export interface RCASummary {
  id: string;
  alert_name: string;
  status: RCAStatus;
  service_name: string | null;
  deployment_environment_name: string | null;
  domain: string | null;
  legal_company: string | null;
  sub_domain: string | null;
  system_id: string | null;
  team: string | null;
  version: string | null;
  confidence_level: ConfidenceLevel | null;
  total_steps: number | null;
  total_tokens: number | null;
  duration_seconds: number | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  /** Number of duplicate alerts absorbed by this RCA. */
  duplicate_count: number;
}

export interface RCADetail extends RCASummary {
  alert_id: string | null;
  root_cause: string | null;
  report_markdown: string | null;
  confidence_reasoning: string | null;
  error_message: string | null;
  /** 1 = positive (thumbs up), 0 = negative (thumbs down), null = no feedback */
  feedback_rating: 0 | 1 | null;
  feedback_comment: string | null;
  steps: AgentStep[];
  /** Chronological list of suppressed duplicate alerts. */
  duplicate_alerts: DuplicateAlertInfo[];
}

export interface FeedbackPayload {
  /** 1 = positive (thumbs up), 0 = negative (thumbs down) */
  rating: 0 | 1;
  comment?: string | null;
}

export interface RCAListResponse {
  items: RCASummary[];
  total: number;
  page: number;
  page_size: number;
}

export type RCAStatus = 'triggered' | 'investigating' | 'complete' | 'failed';
export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface RCAFilters {
  service_name?: string[];
  deployment_environment_name?: string[];
  domain?: string[];
  legal_company?: string[];
  sub_domain?: string[];
  system_id?: string[];
  team?: string[];
  version?: string[];
  status?: RCAStatus[];
  alert_name?: string;
  page?: number;
  page_size?: number;
}

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

export interface DashboardStatsFilters {
  service_name?: string[];
  deployment_environment_name?: string[];
  domain?: string[];
  sub_domain?: string[];
  team?: string[];
}

export interface FilterValues {
  teams: string[];
  services: string[];
  environments: string[];
  domains: string[];
  sub_domains: string[];
  statuses: string[];
}
