/**
 * Session API service — Phase 2 harness session endpoints.
 *
 * All calls route through the Grafana plugin backend proxy at:
 *   /api/plugins/vikshana-graft-app/resources/sessions/...
 *
 * The Go plugin backend enforces RBAC, injects X-Grafana-Org-Id, and
 * forwards to the ORCA FastAPI service with an HMAC signature.
 *
 * SSE streaming uses raw fetch() + ReadableStream (same pattern as rcaApi.ts)
 * because getBackendSrv() buffers the full response before resolving.
 */

import { getBackendSrv } from '@grafana/runtime';

import type {
  ApproveActionRequest,
  DrillDownResult,
  FeedbackRequest,
  SessionListResponse,
  TurnEnqueueResponse,
} from '../types/session.types';
import { parseSseChunk } from './rcaApi';

export { parseSseChunk };

const SESSION_API_BASE = '/api/plugins/vikshana-graft-app/resources/sessions';

// ---------------------------------------------------------------------------
// Non-streaming helpers (via Grafana SDK)
// ---------------------------------------------------------------------------

/**
 * Fetch metadata for a single session (id, initiator_user_id, status, etc.)
 */
export async function getSessionMeta(sessionId: string): Promise<{ id: string; initiator_user_id?: string; [key: string]: unknown }> {
  const resp = await getBackendSrv().fetch<{ sessions: Array<{ id: string; initiator_user_id?: string; [key: string]: unknown }> }>({
    url: `${SESSION_API_BASE}?limit=100`,
    method: 'GET',
  });
  const data = await resp.toPromise().then((r) => r!.data);
  return data.sessions.find((s) => s.id === sessionId) ?? { id: sessionId };
}

/**
 * List harness sessions for the current organisation.
 */
export async function listSessions(
  filters: {
    status?: string;
    type?: string;
    limit?: number;
  } = {}
): Promise<SessionListResponse> {
  const params = new URLSearchParams();
  if (filters.status) {
    params.set('status', filters.status);
  }
  if (filters.type) {
    params.set('type', filters.type);
  }
  if (filters.limit !== undefined) {
    params.set('limit', String(filters.limit));
  }
  const qs = params.toString() ? `?${params.toString()}` : '';
  const response = await getBackendSrv().fetch<SessionListResponse>({
    url: `${SESSION_API_BASE}${qs}`,
    method: 'GET',
  });
  return response.toPromise().then((r) => r!.data);
}

/**
 * Post a turn to an existing session.
 * Returns job_id and whether the session was already busy (agent_busy).
 */
export async function postTurn(
  sessionId: string,
  input: Record<string, unknown>
): Promise<TurnEnqueueResponse> {
  const response = await getBackendSrv().fetch<TurnEnqueueResponse>({
    url: `${SESSION_API_BASE}/${sessionId}/turns`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    data: input,
  });
  return response.toPromise().then((r) => r!.data);
}

/**
 * Approve or deny a pending write-class tool call.
 * Only the session initiator's approval will be accepted by the server.
 */
export async function approveAction(
  sessionId: string,
  body: ApproveActionRequest
): Promise<void> {
  await getBackendSrv()
    .fetch({
      url: `${SESSION_API_BASE}/${sessionId}/approve`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      data: body,
    })
    .toPromise();
}

/**
 * Submit thumbs-up/down feedback for a completed session.
 */
export async function postFeedback(
  sessionId: string,
  body: FeedbackRequest
): Promise<void> {
  await getBackendSrv()
    .fetch({
      url: `${SESSION_API_BASE}/${sessionId}/feedback`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      data: body,
    })
    .toPromise();
}

/**
 * Retrieve the full stored tool result for a drill-down handle (Option B).
 * Used by EvidencePanel to re-execute the original Grafana query as the
 * current viewing user.
 */
export async function getDrillDown(handle: string): Promise<DrillDownResult> {
  const response = await getBackendSrv().fetch<DrillDownResult>({
    url: `${SESSION_API_BASE}/drill-down/${encodeURIComponent(handle)}`,
    method: 'GET',
  });
  return response.toPromise().then((r) => r!.data);
}

// ---------------------------------------------------------------------------
// Streaming helper (raw fetch + ReadableStream)
// ---------------------------------------------------------------------------

/**
 * Open an SSE stream for a session.
 *
 * Returns the raw Response object.  Callers consume response.body as a
 * ReadableStream to receive SessionStreamEvent objects.
 *
 * Usage:
 *   const response = await streamSession(sessionId);
 *   const reader = response.body!.getReader();
 *   const decoder = new TextDecoder();
 *   while (true) {
 *     const { done, value } = await reader.read();
 *     if (done) break;
 *     const events = parseSseChunk(decoder.decode(value));
 *     for (const event of events) { ... }
 *   }
 */
export async function streamSession(sessionId: string): Promise<Response> {
  return fetch(`${SESSION_API_BASE}/${encodeURIComponent(sessionId)}/stream`, {
    method: 'GET',
    headers: { Accept: 'text/event-stream' },
    credentials: 'include',
  });
}
