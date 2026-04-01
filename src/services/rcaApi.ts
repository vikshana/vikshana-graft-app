/**
 * RCA API service.
 *
 * All calls route through the Grafana plugin backend proxy at:
 *   /api/plugins/vikshana-graft-app/resources/rca/api/...
 *
 * The Go plugin backend injects the correct X-Grafana-Org-Id header
 * (from PluginContext.OrgID, not spoofable by the browser client) and
 * reverse-proxies to the ORCA FastAPI service.
 *
 * NOTE: The /start and /refine endpoints return SSE streams.  These are
 * consumed with raw `fetch()` + ReadableStream — NOT getBackendSrv().fetch()
 * because the Grafana SDK buffers the full response before resolving.
 */

import { getBackendSrv } from '@grafana/runtime';

import {
  RCAAcceptResponse,
  RCAHistoryResponse,
  RCAListResponse,
  RCASearchResponse,
  RCAStartRequest,
  DashboardStats,
} from '../types/rca.types';

const RCA_API_BASE = '/api/plugins/vikshana-graft-app/resources/rca/api';

// ---------------------------------------------------------------------------
// Non-streaming helpers (via Grafana SDK)
// ---------------------------------------------------------------------------

/**
 * Accept the current hypothesis and write the final RCA report.
 * This call resumes the LangGraph thread with developer_accepted=True.
 */
export async function acceptRCA(threadId: string): Promise<RCAAcceptResponse> {
  const response = await getBackendSrv().fetch<RCAAcceptResponse>({
    url: `${RCA_API_BASE}/rca/${threadId}/accept`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    data: {},
  });
  return response.toPromise().then((r) => r!.data);
}

/**
 * Get the full hypothesis trail and Q&A transcript for a thread.
 */
export async function getHistory(threadId: string): Promise<RCAHistoryResponse> {
  const response = await getBackendSrv().fetch<RCAHistoryResponse>({
    url: `${RCA_API_BASE}/rca/${threadId}/history`,
    method: 'GET',
  });
  return response.toPromise().then((r) => r!.data);
}

/**
 * List RCA sessions (legacy flow) with optional filters and pagination.
 */
export async function listRCAs(
  filters: {
    service_name?: string;
    deployment_environment_name?: string;
    team?: string;
    domain?: string;
    status?: string;
    alert_name?: string;
    page?: number;
    page_size?: number;
  } = {}
): Promise<RCAListResponse> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') {
      params.set(key, String(value));
    }
  }
  const response = await getBackendSrv().fetch<RCAListResponse>({
    url: `${RCA_API_BASE}/rca?${params.toString()}`,
    method: 'GET',
  });
  return response.toPromise().then((r) => r!.data);
}

/**
 * Get aggregate dashboard statistics.
 */
export async function getStats(): Promise<DashboardStats> {
  const response = await getBackendSrv().fetch<DashboardStats>({
    url: `${RCA_API_BASE}/stats`,
    method: 'GET',
  });
  return response.toPromise().then((r) => r!.data);
}

/**
 * Semantic similarity search over historical RCA sessions.
 */
export async function searchRCAs(
  q: string,
  filters: { service?: string; alert_type?: string; limit?: number } = {}
): Promise<RCASearchResponse> {
  const params = new URLSearchParams({ q });
  if (filters.service) {
    params.set('service', filters.service);
  }
  if (filters.alert_type) {
    params.set('alert_type', filters.alert_type);
  }
  if (filters.limit !== undefined) {
    params.set('limit', String(filters.limit));
  }
  const response = await getBackendSrv().fetch<RCASearchResponse>({
    url: `${RCA_API_BASE}/rca/search?${params.toString()}`,
    method: 'GET',
  });
  return response.toPromise().then((r) => r!.data);
}

/**
 * Submit thumbs-up/down feedback on a completed RCA.
 */
export async function submitFeedback(
  rcaId: string,
  rating: number,
  comment?: string
): Promise<void> {
  await getBackendSrv()
    .fetch({
      url: `${RCA_API_BASE}/rca/${rcaId}/feedback`,
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      data: { rating, comment: comment ?? null },
    })
    .toPromise();
}

// ---------------------------------------------------------------------------
// Streaming helpers (raw fetch + ReadableStream — NOT getBackendSrv)
// ---------------------------------------------------------------------------

/**
 * Parse a raw SSE chunk (may contain multiple "data: {...}\n\n" segments).
 * Returns an array of parsed event objects.
 */
export function parseSseChunk(chunk: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  const lines = chunk.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('data: ')) {
      try {
        const json = trimmed.slice('data: '.length);
        events.push(JSON.parse(json) as Record<string, unknown>);
      } catch {
        // Skip malformed lines
      }
    }
  }
  return events;
}

/**
 * Start a new RCA investigation and stream agent progress as SSE events.
 *
 * Returns the raw Response object. Callers should consume `response.body`
 * as a ReadableStream to receive SSE events.
 *
 * Usage:
 *   const response = await startRCAStream(req);
 *   const reader = response.body!.getReader();
 *   const decoder = new TextDecoder();
 *   while (true) {
 *     const { done, value } = await reader.read();
 *     if (done) break;
 *     const events = parseSseChunk(decoder.decode(value));
 *     for (const event of events) { ... }
 *   }
 */
export async function startRCAStream(body: RCAStartRequest): Promise<Response> {
  return fetch(`${RCA_API_BASE}/rca/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'include',
  });
}

/**
 * Send a follow-up developer question and stream the agent's response.
 *
 * Returns the raw Response object.  Consume `response.body` as a
 * ReadableStream to receive SSE events (step, hypothesis, interrupt, done).
 */
export async function refineRCAStream(threadId: string, message: string): Promise<Response> {
  return fetch(`${RCA_API_BASE}/rca/${threadId}/refine`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
    credentials: 'include',
  });
}
