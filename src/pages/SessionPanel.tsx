/**
 * SessionPanel — the primary Phase 2 session investigation UI.
 *
 * Consumes an SSE stream from /api/sessions/:id/stream and drives a state
 * machine matching SessionStatus.
 *
 * URL: /sessions/:sessionId
 *
 * State machine:
 *   idle           → stream not yet opened
 *   running        → receiving step/tool_call/tool_result events
 *   awaiting_input → interrupt received; hypothesis shown, Q&A input visible
 *   awaiting_approval → write tool needs human approval (initiator only)
 *   paused         → budget/reauth/timeout/provider_unavailable event received
 *   complete       → done event with reason=complete
 *   failed         → error event
 *
 * Option A coexistence: this page lives at /sessions/:id alongside the
 * existing /rca/investigate/:threadId (RCAInvestigate.tsx is untouched).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Alert, Button, LoadingBar, Stack, TextArea } from '@grafana/ui';
import { useStyles2 } from '@grafana/ui';
import { css } from '@emotion/css';

import { parseSseChunk, streamSession } from '../services/sessionApi';
import { PageHeader } from '../components/common/PageHeader';
import {
  AgentBusyBanner,
  ApprovalModal,
  EvidencePanel,
  FeedbackWidget,
  PausedStateBanner,
  ToolCallFeed,
} from '../components/features/Session';
import type {
  AgentBusyEvent,
  AwaitingApprovalEvent,
  PausedReason,
  SessionStatus,
  SessionStreamEvent,
  ToolCallStep,
} from '../types/session.types';

export function SessionPanel() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const styles = useStyles2(getStyles);

  const [status, setStatus] = useState<SessionStatus>('idle');
  const [toolSteps, setToolSteps] = useState<ToolCallStep[]>([]);
  const [hypothesis, setHypothesis] = useState<{ text: string; suggested_questions: string[] } | null>(null);
  const [question, setQuestion] = useState('');
  const [approvalRequest, setApprovalRequest] = useState<AwaitingApprovalEvent | null>(null);
  const [pausedReason, setPausedReason] = useState<PausedReason | null>(null);
  const [pausedResumable, setPausedResumable] = useState(false);
  const [busyPosition, setBusyPosition] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [activeDrillDown, setActiveDrillDown] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Determine if the current user is the session initiator.
  // We use a lazy approach: assume initiator until proven otherwise.
  // The real initiator_user_id comes from the session metadata; for now we
  // default to true so the ApprovalModal renders in demos without a full session fetch.
  const isInitiator = true; // TODO Phase 4: compare contextSrv.user.id with session.initiator_user_id

  // Auto-scroll to bottom as steps arrive
  useEffect(() => {
    if (typeof bottomRef.current?.scrollIntoView === 'function') {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [toolSteps]);

  const startStream = useCallback(async () => {
    if (!sessionId) {
      return;
    }
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    setStatus('running');
    setToolSteps([]);
    setHypothesis(null);
    setErrorMsg(null);
    setBusyPosition(null);

    let response: Response;
    try {
      response = await streamSession(sessionId);
    } catch (e) {
      if (!abort.signal.aborted) {
        setErrorMsg(String(e));
        setStatus('failed');
      }
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      setErrorMsg('No response body');
      setStatus('failed');
      return;
    }

    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done || abort.signal.aborted) {
          break;
        }
        const text = decoder.decode(value);
        const events = parseSseChunk(text) as unknown as SessionStreamEvent[];
        for (const event of events) {
          handleEvent(event);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleEvent(event: SessionStreamEvent) {
    switch (event.type) {
      case 'step':
        // Clear agent_busy banner on first real event
        setBusyPosition(null);
        break;

      case 'tool_call':
        setToolSteps((prev) => [
          ...prev,
          {
            id: event.tool_call_id ?? String(Date.now()),
            tool: event.tool,
            args: event.args,
            status: 'running',
            drillDownHandle: event.drill_down_handle,
            timestamp: new Date(),
          },
        ]);
        break;

      case 'tool_result':
        setToolSteps((prev) =>
          prev.map((s) =>
            s.tool === event.tool && s.status === 'running'
              ? {
                  ...s,
                  status: 'done',
                  resultPreview: event.result_preview,
                  drillDownHandle: event.drill_down_handle ?? s.drillDownHandle,
                }
              : s
          )
        );
        break;

      case 'hypothesis':
        setHypothesis(event.hypothesis);
        break;

      case 'interrupt':
        if (event.hypothesis) {
          setHypothesis(event.hypothesis);
        }
        setStatus('awaiting_input');
        break;

      case 'awaiting_approval':
        setApprovalRequest(event);
        setStatus('awaiting_approval');
        break;

      case 'agent_busy':
        setBusyPosition((event as AgentBusyEvent).queue_position);
        break;

      case 'budget_exceeded':
      case 'reauth_required':
      case 'provider_unavailable':
      case 'timeout':
        setPausedReason(event.type as PausedReason);
        setPausedResumable((event as { resumable: boolean }).resumable ?? false);
        setStatus('paused');
        break;

      case 'done':
        if ((event as { reason: string }).reason === 'complete') {
          setStatus('complete');
        } else {
          setStatus('awaiting_input');
        }
        break;

      case 'error':
        setErrorMsg((event as { message: string }).message);
        setStatus('failed');
        break;
    }
  }

  useEffect(() => {
    startStream();
    return () => {
      abortRef.current?.abort();
    };
  }, [startStream]);

  async function handleSendQuestion() {
    if (!question.trim() || !sessionId) {
      return;
    }
    // Post a turn with the developer's question
    const { postTurn } = await import('../services/sessionApi');
    setStatus('running');
    setQuestion('');
    try {
      const { is_busy } = await postTurn(sessionId, { message: question.trim() });
      if (is_busy) {
        setBusyPosition(1);
      }
      // Re-open the stream to receive the response
      startStream();
    } catch (e) {
      setErrorMsg(String(e));
      setStatus('failed');
    }
  }

  async function handleAccept() {
    if (!sessionId) {
      return;
    }
    const { postTurn } = await import('../services/sessionApi');
    setStatus('running');
    try {
      await postTurn(sessionId, { developer_accepted: true });
      startStream();
    } catch (e) {
      setErrorMsg(String(e));
      setStatus('failed');
    }
  }

  return (
    <div className={styles.container}>
      <PageHeader title={`Session — ${sessionId?.slice(0, 8)}…`} />

      {/* Transient banners */}
      {busyPosition !== null && <AgentBusyBanner queuePosition={busyPosition} />}
      {status === 'paused' && pausedReason && (
        <PausedStateBanner
          reason={pausedReason}
          resumable={pausedResumable}
          onResume={() => startStream()}
        />
      )}

      {/* Running indicator */}
      {status === 'running' && <LoadingBar width={400} />}

      {/* Tool call feed */}
      <ToolCallFeed
        steps={toolSteps}
        onDrillDown={(handle) => setActiveDrillDown(handle)}
      />

      {/* Drill-down evidence panel */}
      {activeDrillDown && sessionId && (
        <div className={styles.evidenceSection}>
          <EvidencePanel handle={activeDrillDown} sessionId={sessionId} />
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setActiveDrillDown(null)}
          >
            Close evidence
          </Button>
        </div>
      )}

      {/* Hypothesis + Q&A */}
      {hypothesis && (
        <div className={styles.hypothesis} data-testid="hypothesis-panel">
          <h4>Current hypothesis</h4>
          <p>{hypothesis.text}</p>
          {hypothesis.suggested_questions.length > 0 && (
            <div>
              <p style={{ color: '#9fa7b3', fontSize: 12 }}>Suggested questions:</p>
              <ul>
                {hypothesis.suggested_questions.map((q, i) => (
                  <li
                    key={i}
                    style={{ cursor: 'pointer', color: '#6e9fff', fontSize: 13 }}
                    onClick={() => setQuestion(q)}
                  >
                    {q}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Awaiting input controls */}
      {status === 'awaiting_input' && (
        <div className={styles.qaInput}>
          <TextArea
            placeholder="Ask a follow-up question or leave blank to accept…"
            value={question}
            onChange={(e) => setQuestion(e.currentTarget.value)}
            rows={3}
          />
          <Stack direction="row" gap={1}>
            <Button
              variant="primary"
              onClick={handleSendQuestion}
              disabled={!question.trim()}
            >
              Send
            </Button>
            <Button
              variant="secondary"
              data-testid="accept-button"
              onClick={handleAccept}
            >
              Accept hypothesis
            </Button>
          </Stack>
        </div>
      )}

      {/* Error state */}
      {status === 'failed' && errorMsg && (
        <Alert severity="error" title="Investigation failed">
          {errorMsg}
        </Alert>
      )}

      {/* Approval modal (initiator only) */}
      {sessionId && (
        <ApprovalModal
          request={approvalRequest}
          sessionId={sessionId}
          isInitiator={isInitiator}
          onDecision={() => {
            setApprovalRequest(null);
            setStatus('running');
            startStream();
          }}
        />
      )}

      {/* Completion state */}
      {status === 'complete' && (
        <div data-testid="session-complete">
          <Alert severity="success" title="Investigation complete">
            The hypothesis has been accepted and the RCA report has been generated.
          </Alert>
          {sessionId && <FeedbackWidget sessionId={sessionId} />}
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}

const getStyles = () => ({
  container: css`
    padding: 16px;
    max-width: 900px;
  `,
  hypothesis: css`
    background: rgba(110, 159, 255, 0.05);
    border: 1px solid rgba(110, 159, 255, 0.15);
    border-radius: 4px;
    padding: 16px;
    margin: 16px 0;
    h4 {
      margin: 0 0 8px 0;
    }
  `,
  qaInput: css`
    margin: 16px 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  `,
  evidenceSection: css`
    margin: 12px 0;
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: 4px;
    padding: 12px;
  `,
});
