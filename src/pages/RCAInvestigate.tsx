/**
 * RCAInvestigate — the primary interactive RCA investigation panel.
 *
 * Consumes SSE streams from /api/rca/start and /api/rca/{threadId}/refine
 * to show real-time agent progress, then surfaces the hypothesis for
 * developer interrogation before final acceptance.
 *
 * URL: /rca/investigate/:threadId
 *
 * If :threadId is 'new', a new RCA session is started.
 * Otherwise an existing thread is resumed (e.g. linked from RCAList).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useStyles2, Alert, TextArea, Button, Spinner, Icon } from '@grafana/ui';

import {
  acceptRCA,
  getHistory,
  parseSseChunk,
  refineRCAStream,
  startRCAStream,
} from '../services/rcaApi';
import { prefixRoute } from '../utils/utils.routing';
import { ROUTES } from '../constants';
import {
  DoneEvent,
  ErrorEvent,
  Hypothesis,
  HypothesisEvent,
  InterruptEvent,
  QATurn,
  RCAInvestigateStatus,
  RCAStartRequest,
  SessionCreatedEvent,
  StepEvent,
} from '../types/rca.types';
import { testIds } from '../components/testIds';
import { PageHeader } from '../components/common/PageHeader';
import { getStyles } from './RCAInvestigate.styles';

interface AgentStep {
  node: string;
  status: 'started' | 'complete';
  timestamp: Date;
}

export function RCAInvestigate() {
  const { threadId: routeThreadId } = useParams<{ threadId: string }>();
  const navigate = useNavigate();
  const styles = useStyles2(getStyles);

  // Core session state
  const [threadId, setThreadId] = useState<string | null>(
    routeThreadId !== 'new' ? (routeThreadId ?? null) : null
  );
  const [status, setStatus] = useState<RCAInvestigateStatus>('idle');
  const [hypothesis, setHypothesis] = useState<Hypothesis | null>(null);
  const [confidence, setConfidence] = useState<number>(0);
  const [round, setRound] = useState<number>(0);
  const [qaTranscript, setQaTranscript] = useState<QATurn[]>([]);

  // Streaming progress
  const [agentSteps, setAgentSteps] = useState<AgentStep[]>([]);
  const [streamError, setStreamError] = useState<string | null>(null);

  // Accept result
  const [finalReport, setFinalReport] = useState<Record<string, unknown> | null>(null);

  // Developer input
  const [userMessage, setUserMessage] = useState('');
  const [acceptWarning, setAcceptWarning] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to bottom as steps arrive (guarded for test environments)
  useEffect(() => {
    if (typeof bottomRef.current?.scrollIntoView === 'function') {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [agentSteps, qaTranscript]);

  // If there's an existing threadId on mount, load history
  useEffect(() => {
    if (threadId && routeThreadId !== 'new') {
      loadHistory(threadId);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadHistory(tid: string) {
    setStatus('starting');
    try {
      const history = await getHistory(tid);
      if (history.hypotheses.length > 0) {
        setHypothesis(history.hypotheses[history.hypotheses.length - 1]);
        setConfidence(history.confidence_scores[history.confidence_scores.length - 1] ?? 0);
      }
      setRound(history.round);
      setQaTranscript(history.qa_transcript);
      if (history.final_report) {
        setFinalReport(history.final_report);
        setStatus('complete');
      } else {
        setStatus('awaiting_input');
      }
    } catch {
      setStatus('failed');
      setStreamError('Failed to load RCA history');
    }
  }

  // ---------------------------------------------------------------------------
  // Start a new RCA
  // ---------------------------------------------------------------------------

  async function handleStart(req: RCAStartRequest) {
    setStatus('starting');
    setAgentSteps([]);
    setStreamError(null);

    abortRef.current = new AbortController();

    try {
      const response = await startRCAStream(req);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      await consumeSseStream(response);
    } catch (err: unknown) {
      if ((err as Error).name !== 'AbortError') {
        setStreamError(err instanceof Error ? err.message : 'Stream error');
        setStatus('failed');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Refine — send a developer question
  // ---------------------------------------------------------------------------

  const handleRefine = useCallback(async () => {
    if (!threadId || !userMessage.trim()) {
      return;
    }

    const msg = userMessage.trim();
    setUserMessage('');
    setStatus('refining');
    setQaTranscript((prev) => [...prev, { role: 'developer', content: msg }]);

    abortRef.current = new AbortController();

    try {
      const response = await refineRCAStream(threadId, msg);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      await consumeSseStream(response);
    } catch (err: unknown) {
      if ((err as Error).name !== 'AbortError') {
        setStreamError(err instanceof Error ? err.message : 'Stream error');
        setStatus('failed');
      }
    }
  }, [threadId, userMessage]);

  // ---------------------------------------------------------------------------
  // Accept — finalize the hypothesis
  // ---------------------------------------------------------------------------

  async function handleAccept() {
    if (!threadId) {
      return;
    }

    if (confidence < 0.6 && !acceptWarning) {
      setAcceptWarning(true);
      return;
    }

    setStatus('accepting');
    setAcceptWarning(false);

    try {
      const result = await acceptRCA(threadId);
      setFinalReport(result.final_report);
      setStatus('complete');
      navigate(prefixRoute(`${ROUTES.RcaInvestigate}/${threadId}`), { replace: true });
    } catch (err: unknown) {
      setStreamError(err instanceof Error ? err.message : 'Accept failed');
      setStatus('failed');
    }
  }

  // ---------------------------------------------------------------------------
  // Shared SSE stream consumer
  // ---------------------------------------------------------------------------

  async function consumeSseStream(response: Response) {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        const events = parseSseChunk(chunk);

        for (const raw of events) {
          const eventType = raw['type'] as string;

          if (eventType === 'session_created') {
            const evt = raw as unknown as SessionCreatedEvent;
            setThreadId(evt.thread_id);
            navigate(prefixRoute(`${ROUTES.RcaInvestigate}/${evt.thread_id}`), { replace: true });
          } else if (eventType === 'step') {
            const evt = raw as unknown as StepEvent;
            setAgentSteps((prev) => [
              ...prev,
              { node: evt.node, status: evt.status, timestamp: new Date() },
            ]);
          } else if (eventType === 'hypothesis') {
            const evt = raw as unknown as HypothesisEvent;
            setHypothesis(evt.hypothesis);
            setConfidence(evt.confidence);
          } else if (eventType === 'interrupt') {
            const evt = raw as unknown as InterruptEvent;
            if (evt.hypothesis) {
              setHypothesis(evt.hypothesis);
            }
            setConfidence(evt.confidence);
            setRound(evt.round);
            setStatus('awaiting_input');
          } else if (eventType === 'done') {
            const evt = raw as unknown as DoneEvent;
            if (evt.reason === 'complete') {
              setStatus('complete');
            }
          } else if (eventType === 'error') {
            const evt = raw as unknown as ErrorEvent;
            setStreamError(evt.message);
            setStatus('failed');
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const isStreaming = status === 'starting' || status === 'refining';
  const isAccepting = status === 'accepting';
  const isAwaiting = status === 'awaiting_input';
  const isComplete = status === 'complete';

  return (
    <div className={styles.container} data-testid={testIds.rcaInvestigate.container}>
      <PageHeader
        title="RCA Investigation"
        backTo={prefixRoute(ROUTES.RcaRuns)}
        data-testid={testIds.rcaInvestigate.backButton}
        actions={
          <>
            {round > 0 && (
              <span className={styles.roundBadge}>Round {round}</span>
            )}
            {isStreaming && <Spinner size="sm" />}
          </>
        }
      />

      <div className={styles.content}>
        {streamError && (
          <Alert title="Error" severity="error" className={styles.alert}>
            {streamError}
          </Alert>
        )}

        {/* Agent steps feed */}
        {agentSteps.length > 0 && (
          <div className={styles.stepsPanel} data-testid={testIds.rcaInvestigate.stepsPanel}>
            <h3 className={styles.sectionTitle}>Agent Steps</h3>
            {agentSteps.map((step, i) => (
              <div key={i} className={styles.stepRow} data-status={step.status}>
                <Icon
                  name={step.status === 'complete' ? 'check' : 'hourglass'}
                  size="sm"
                />
                <span className={styles.stepNode}>{step.node.replaceAll('_', ' ')}</span>
                <span className={styles.stepStatus}>{step.status}</span>
              </div>
            ))}
          </div>
        )}

        {/* Working hypothesis */}
        {hypothesis && (
          <div className={styles.hypothesisPanel} data-testid={testIds.rcaInvestigate.hypothesisPanel}>
            <h3 className={styles.sectionTitle}>
              Working Hypothesis
              <span className={styles.confidenceBadge} data-level={confidenceLevel(confidence)}>
                {Math.round(confidence * 100)}% confidence
              </span>
            </h3>
            <p className={styles.hypothesisText}>{hypothesis.text}</p>

            {hypothesis.high_confidence_areas.length > 0 && (
              <div className={styles.areaRow}>
                <span className={styles.areaLabel}>
                  <Icon name="check-circle" size="sm" />
                  High confidence:
                </span>
                {hypothesis.high_confidence_areas.map((a, i) => (
                  <span key={i} className={styles.areaChip}>{a}</span>
                ))}
              </div>
            )}

            {hypothesis.uncertain_areas.length > 0 && (
              <div className={styles.areaRow}>
                <span className={styles.areaLabel}>
                  <Icon name="exclamation-triangle" size="sm" />
                  Uncertain:
                </span>
                {hypothesis.uncertain_areas.map((a, i) => (
                  <span key={i} className={styles.areaChipWarn}>{a}</span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Q&A transcript */}
        {qaTranscript.length > 0 && (
          <div className={styles.transcriptPanel} data-testid={testIds.rcaInvestigate.transcriptPanel}>
            <h3 className={styles.sectionTitle}>Q&amp;A Transcript</h3>
            {qaTranscript.map((turn, i) => (
              <div key={i} className={styles.turnRow} data-role={turn.role}>
                <span className={styles.turnRole}>
                  <Icon name={turn.role === 'developer' ? 'user' : 'process'} size="sm" />
                  {turn.role === 'developer' ? 'You' : 'Agent'}
                </span>
                <p className={styles.turnContent}>{turn.content}</p>
              </div>
            ))}
          </div>
        )}

        {/* Final report */}
        {isComplete && finalReport && (
          <div className={styles.reportPanel} data-testid={testIds.rcaInvestigate.reportPanel}>
            <h3 className={styles.sectionTitle}>Final RCA Report</h3>
            <div className={styles.reportContent}>
              <p><strong>Executive Summary:</strong> {String(finalReport['executive_summary'] ?? '')}</p>
              <p><strong>Root Cause:</strong> {String(finalReport['root_cause'] ?? '')}</p>
              {Array.isArray(finalReport['recommendations']) && (
                <>
                  <p><strong>Recommendations:</strong></p>
                  <ul>
                    {(finalReport['recommendations'] as string[]).map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>
        )}

        {/* Developer input area */}
        {(isAwaiting || isStreaming) && (
          <div className={styles.inputPanel} data-testid={testIds.rcaInvestigate.inputPanel}>
            {/* Suggested questions */}
            {isAwaiting && hypothesis?.suggested_questions && hypothesis.suggested_questions.length > 0 && (
              <div className={styles.suggestedQRow}>
                <span className={styles.suggestedLabel}>Agent suggests:</span>
                {hypothesis.suggested_questions.map((q, i) => (
                  <Button
                    key={i}
                    variant="secondary"
                    fill="outline"
                    size="sm"
                    onClick={() => setUserMessage(q)}
                  >
                    {q}
                  </Button>
                ))}
              </div>
            )}

            <div className={styles.inputRow}>
              <TextArea
                placeholder="Ask a follow-up question..."
                value={userMessage}
                onChange={(e) => setUserMessage(e.currentTarget.value)}
                rows={2}
                disabled={isStreaming}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleRefine();
                  }
                }}
                className={styles.textarea}
                data-testid={testIds.rcaInvestigate.messageInput}
              />
              <Button
                variant="primary"
                onClick={handleRefine}
                disabled={isStreaming || !userMessage.trim() || !threadId}
                data-testid={testIds.rcaInvestigate.sendButton}
              >
                Send
              </Button>
            </div>

            {acceptWarning && (
              <Alert title="Low confidence" severity="warning" className={styles.alert}>
                Confidence is below 60%. Are you sure you want to accept this hypothesis?
                Click Accept again to confirm.
              </Alert>
            )}

            <div className={styles.acceptRow}>
              <Button
                variant="secondary"
                icon={isAccepting ? undefined : 'check'}
                onClick={handleAccept}
                disabled={isStreaming || isAccepting || !hypothesis || !threadId}
                data-testid={testIds.rcaInvestigate.acceptButton}
              >
                {isAccepting ? <><Spinner size="sm" /> Accepting…</> : 'Accept as Final RCA'}
              </Button>
            </div>
          </div>
        )}

        {/* Start prompt when no thread yet (route to /rca/investigate/new) */}
        {status === 'idle' && !threadId && (
          <div className={styles.startPrompt}>
            <p>Start a new RCA investigation from a Grafana alert webhook,
              or navigate here from the alert manager.</p>
            <Button
              variant="primary"
              onClick={() =>
                handleStart({
                  alert_context: {
                    alert_name: 'Manual investigation',
                    description: 'Manually triggered RCA',
                    labels: {},
                  },
                })
              }
              data-testid={testIds.rcaInvestigate.startButton}
            >
              Start Manual Investigation
            </Button>
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function confidenceLevel(score: number): 'high' | 'medium' | 'low' {
  if (score >= 0.7) {
    return 'high';
  }
  if (score >= 0.4) {
    return 'medium';
  }
  return 'low';
}
