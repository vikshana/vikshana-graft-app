import React from 'react';
import { Alert } from '@grafana/ui';

interface Props {
  queuePosition: number;
}

/**
 * AgentBusyBanner — shown when an `agent_busy` SSE event is received.
 *
 * Informs the user that their turn has been queued and the agent is currently
 * processing another turn for this session.  The banner is dismissed by the
 * parent component when the next meaningful SSE event arrives.
 */
export function AgentBusyBanner({ queuePosition }: Props) {
  return (
    <Alert
      data-testid="agent-busy-banner"
      severity="info"
      title="Agent is busy"
    >
      Another turn is already running. Your request has been queued — you are
      position {queuePosition} in the queue. Results will appear automatically.
    </Alert>
  );
}
