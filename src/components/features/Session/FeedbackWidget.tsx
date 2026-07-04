import React, { useState } from 'react';
import { Button, IconButton, Stack, TextArea } from '@grafana/ui';

import { postFeedback } from '../../../services/sessionApi';

interface Props {
  sessionId: string;
}

/**
 * FeedbackWidget — thumbs-up/down rating with optional comment for a session.
 *
 * After a rating is selected an optional comment field is shown.
 * Submitting calls POST /api/sessions/{id}/feedback which forwards to Langfuse.
 */
export function FeedbackWidget({ sessionId }: Props) {
  const [score, setScore] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  if (submitted) {
    return (
      <span style={{ color: '#73bf69', fontSize: 12 }}>
        Thanks for your feedback!
      </span>
    );
  }

  async function handleSubmit() {
    if (score === null) {
      return;
    }
    setLoading(true);
    try {
      await postFeedback(sessionId, { score, comment: comment || undefined });
      setSubmitted(true);
    } catch {
      // best-effort — don't break the UI
    } finally {
      setLoading(false);
    }
  }

  return (
    <Stack direction="column" gap={1} data-testid="feedback-widget">
      <span style={{ fontSize: 12, color: '#9fa7b3' }}>Rate this investigation:</span>
      <Stack direction="row" gap={1} alignItems="center">
        <IconButton
          data-testid="thumbs-up"
          name="thumbs-up"
          size="md"
          aria-label="Thumbs up"
          style={{ color: score === 1 ? '#73bf69' : undefined }}
          onClick={() => setScore(1)}
        />
        <IconButton
          data-testid="thumbs-down"
          name="thumbs-down"
          size="md"
          aria-label="Thumbs down"
          style={{ color: score === 0 ? '#f2495c' : undefined }}
          onClick={() => setScore(0)}
        />
      </Stack>
      {score !== null && (
        <>
          <TextArea
            placeholder="Optional comment…"
            value={comment}
            onChange={(e) => setComment(e.currentTarget.value)}
            rows={2}
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={loading}
            onClick={handleSubmit}
          >
            {loading ? 'Submitting…' : 'Submit'}
          </Button>
        </>
      )}
    </Stack>
  );
}
