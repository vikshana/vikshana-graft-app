import React, { useState } from 'react';
import { Button, Modal, Stack } from '@grafana/ui';

import type { AwaitingApprovalEvent } from '../../../types/session.types';
import { approveAction } from '../../../services/sessionApi';

interface Props {
  request: AwaitingApprovalEvent | null;
  sessionId: string;
  /** True only when the current Grafana user is the session initiator. */
  isInitiator: boolean;
  onDecision: () => void;
}

/**
 * ApprovalModal — shown when a write-class tool call requires human approval.
 *
 * Only renders when `isInitiator` is true — the server re-checks this
 * regardless of whether the modal is shown, so this is a UX convenience only.
 *
 * Displays the tool name and a formatted view of the tool input for review.
 */
export function ApprovalModal({ request, sessionId, isInitiator, onDecision }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isInitiator || request === null) {
    return null;
  }

  async function handleDecision(decision: 'approved' | 'denied') {
    setLoading(true);
    setError(null);
    try {
      await approveAction(sessionId, {
        tool_call_id: request!.tool_call_id,
        decision,
      });
      onDecision();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      data-testid="approval-modal"
      title={`Approve: ${request.tool_name}`}
      isOpen
      onDismiss={() => handleDecision('denied')}
    >
      <Stack direction="column" gap={2}>
        <p>
          The agent wants to execute a <strong>{request.tool_name}</strong> operation.
          Review the details below and approve or deny.
        </p>
        <pre
          data-testid="approval-input-preview"
          style={{
            background: 'rgba(0,0,0,0.2)',
            padding: 8,
            borderRadius: 4,
            fontSize: 12,
            maxHeight: 200,
            overflow: 'auto',
          }}
        >
          {JSON.stringify(request.tool_input, null, 2)}
        </pre>
        {error && <span style={{ color: 'red' }}>{error}</span>}
        <Stack direction="row" gap={1} justifyContent="flex-end">
          <Button
            data-testid="deny-button"
            variant="destructive"
            disabled={loading}
            onClick={() => handleDecision('denied')}
          >
            Deny
          </Button>
          <Button
            data-testid="approve-button"
            variant="primary"
            disabled={loading}
            onClick={() => handleDecision('approved')}
          >
            {loading ? 'Processing…' : 'Approve'}
          </Button>
        </Stack>
      </Stack>
    </Modal>
  );
}
