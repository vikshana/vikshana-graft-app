import React from 'react';
import { Alert, Button, Stack } from '@grafana/ui';

import type { PausedReason } from '../../../types/session.types';

interface Props {
  reason: PausedReason;
  resumable: boolean;
  onResume?: () => void;
}

const MESSAGES: Record<PausedReason, { title: string; body: string }> = {
  budget_exceeded: {
    title: 'Budget reached',
    body: 'Session paused — the token budget for this session has been reached. Start a new session to continue.',
  },
  reauth_required: {
    title: 'Re-authentication required',
    body: 'Your Grafana session has expired. Please sign in again to continue.',
  },
  provider_unavailable: {
    title: 'LLM provider unavailable',
    body: 'The LLM provider is temporarily unavailable. The session is paused and can be resumed once the provider recovers.',
  },
  timeout: {
    title: 'Session timed out',
    body: 'The session timed out due to inactivity or a wall-clock limit. It can be resumed.',
  },
};

/**
 * PausedStateBanner — shown when the session is in a paused state.
 *
 * Displays a reason-specific message and, where applicable, a resume or
 * sign-in button.
 */
export function PausedStateBanner({ reason, resumable, onResume }: Props) {
  const { title, body } = MESSAGES[reason];
  const severity = reason === 'budget_exceeded' ? 'warning' : 'info';

  return (
    <Alert data-testid={`paused-banner-${reason}`} severity={severity} title={title}>
      <Stack direction="column" gap={1}>
        <span>{body}</span>
        {reason === 'reauth_required' && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              window.location.href = '/login';
            }}
          >
            Sign in
          </Button>
        )}
        {resumable && reason !== 'reauth_required' && onResume && (
          <Button
            size="sm"
            variant="secondary"
            data-testid="resume-button"
            onClick={onResume}
          >
            Resume
          </Button>
        )}
        {reason === 'budget_exceeded' && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              window.location.href = window.location.pathname.replace(/\/sessions\/.*/, '/sessions');
            }}
          >
            New Session
          </Button>
        )}
      </Stack>
    </Alert>
  );
}
