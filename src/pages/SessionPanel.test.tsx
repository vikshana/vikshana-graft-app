/**
 * Component tests for SessionPanel and its sub-components.
 *
 * All API calls and SSE streams are mocked.  Tests verify that the
 * correct components are rendered in response to specific SSE events.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Mock sessionApi before importing components
jest.mock('../services/sessionApi', () => ({
  listSessions: jest.fn(),
  getSessionMeta: jest.fn().mockResolvedValue({ id: 'test-session', initiator_user_id: undefined }),
  postTurn: jest.fn().mockResolvedValue({ job_id: 'j1', is_busy: false }),
  approveAction: jest.fn().mockResolvedValue(undefined),
  postFeedback: jest.fn().mockResolvedValue(undefined),
  getDrillDown: jest.fn(),
  streamSession: jest.fn(),
  parseSseChunk: jest.requireActual('../services/rcaApi').parseSseChunk,
}));

// Mock @grafana/runtime before importing components
jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  getBackendSrv: jest.fn(() => ({
    fetch: jest.fn().mockReturnValue({
      toPromise: jest.fn().mockResolvedValue({ data: {} }),
    }),
  })),
  contextSrv: { user: { id: 1 } },
}));

const mockStreamSession = require('../services/sessionApi').streamSession as jest.Mock;
const mockPostFeedback = require('../services/sessionApi').postFeedback as jest.Mock;
const mockApproveAction = require('../services/sessionApi').approveAction as jest.Mock;

/**
 * Build a mock Response-like object that yields SSE events.
 * Uses an async generator to avoid depending on ReadableStream in jsdom.
 */
function buildSseMockResponse(events: Array<Record<string, unknown>>) {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  const encoder = new TextEncoder();
  const encoded = encoder.encode(body);

  // Build a minimal ReadableStream-compatible reader
  const reader = {
    read: jest.fn().mockImplementationOnce(() => {
      return Promise.resolve({ done: false, value: encoded });
    }).mockImplementation(() => Promise.resolve({ done: true, value: undefined })),
    releaseLock: jest.fn(),
  };

  return {
    body: { getReader: () => reader },
    ok: true,
    status: 200,
  } as unknown as Response;
}

function renderSessionPanel(sessionId = 'test-session-id') {
  const { SessionPanel } = require('./SessionPanel');
  return render(
    <MemoryRouter initialEntries={[`/sessions/${sessionId}`]}>
      <Routes>
        <Route path="/sessions/:sessionId" element={<SessionPanel />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('SessionPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders tool call feed when step and tool_call events are received', async () => {
    mockStreamSession.mockResolvedValue(
      buildSseMockResponse([
        { type: 'step', node: 'data_gathering', status: 'started' },
        { type: 'tool_call', tool: 'query_metrics', args: { expr: 'up' }, tool_call_id: 'tc1' },
        { type: 'tool_result', tool: 'query_metrics', result_preview: '3 series', tool_call_id: 'tc1' },
        { type: 'done', reason: 'awaiting_input' },
      ])
    );

    renderSessionPanel();

    await waitFor(() => {
      expect(screen.getByTestId('tool-call-feed')).toBeInTheDocument();
    });
    expect(screen.getByText('query_metrics')).toBeInTheDocument();
  });

  it('shows AgentBusyBanner when agent_busy event is received', async () => {
    mockStreamSession.mockResolvedValue(
      buildSseMockResponse([
        { type: 'agent_busy', session_id: 'test-session-id', queue_position: 2 },
        { type: 'done', reason: 'awaiting_input' },
      ])
    );

    renderSessionPanel();

    await waitFor(() => {
      expect(screen.getByTestId('agent-busy-banner')).toBeInTheDocument();
    });
    expect(screen.getByText(/position 2/)).toBeInTheDocument();
  });

  it('dismisses AgentBusyBanner when a step event follows', async () => {
    mockStreamSession.mockResolvedValue(
      buildSseMockResponse([
        { type: 'agent_busy', session_id: 'test-session-id', queue_position: 1 },
        { type: 'step', node: 'data_gathering', status: 'started' },
        { type: 'done', reason: 'awaiting_input' },
      ])
    );

    renderSessionPanel();

    await waitFor(() => {
      expect(screen.queryByTestId('agent-busy-banner')).not.toBeInTheDocument();
    });
  });

  it('shows PausedStateBanner with budget_exceeded message', async () => {
    mockStreamSession.mockResolvedValue(
      buildSseMockResponse([
        { type: 'budget_exceeded', message: 'Token budget reached', resumable: false },
      ])
    );

    renderSessionPanel();

    await waitFor(() => {
      expect(screen.getByTestId('paused-banner-budget_exceeded')).toBeInTheDocument();
    });
    expect(screen.getByText(/token budget/i)).toBeInTheDocument();
  });

  it('shows PausedStateBanner with reauth_required message and sign-in button', async () => {
    mockStreamSession.mockResolvedValue(
      buildSseMockResponse([
        { type: 'reauth_required', message: 'Session expired', resumable: false },
      ])
    );

    renderSessionPanel();

    await waitFor(() => {
      expect(screen.getByTestId('paused-banner-reauth_required')).toBeInTheDocument();
    });
    expect(screen.getByText('Sign in')).toBeInTheDocument();
  });

  it('shows PausedStateBanner with provider_unavailable and resume button', async () => {
    mockStreamSession.mockResolvedValue(
      buildSseMockResponse([
        { type: 'provider_unavailable', message: 'Provider down', resumable: true },
      ])
    );

    renderSessionPanel();

    await waitFor(() => {
      expect(screen.getByTestId('paused-banner-provider_unavailable')).toBeInTheDocument();
    });
    expect(screen.getByTestId('resume-button')).toBeInTheDocument();
  });

  it('does NOT render ApprovalModal when there is no approval request', async () => {
    mockStreamSession.mockResolvedValue(
      buildSseMockResponse([{ type: 'done', reason: 'awaiting_input' }])
    );

    renderSessionPanel();

    await waitFor(() => {
      expect(screen.queryByTestId('approval-modal')).not.toBeInTheDocument();
    });
  });

  it('renders ApprovalModal when awaiting_approval event received', async () => {
    // Make current user the initiator so the modal is shown
    (require('../services/sessionApi').getSessionMeta as jest.Mock).mockResolvedValue({
      id: 'test-session-id',
      initiator_user_id: 'testuser',
    });
    (window as any).grafanaBootData = { user: { login: 'testuser' } };

    mockStreamSession.mockResolvedValue(
      buildSseMockResponse([
        {
          type: 'awaiting_approval',
          tool_name: 'create_silence',
          tool_input: { matchers: [] },
          tool_call_id: 'tc-approval',
        },
      ])
    );

    renderSessionPanel();

    await waitFor(() => {
      expect(screen.getByTestId('approve-button')).toBeInTheDocument();
    }, { timeout: 5000 });
    // The modal title contains the tool name
    expect(screen.getByText(/Approve:/)).toBeInTheDocument();
  });

  it('calls approveAction with approved on approve button click', async () => {
    (require('../services/sessionApi').getSessionMeta as jest.Mock).mockResolvedValue({
      id: 'test-session-id',
      initiator_user_id: 'testuser',
    });
    (window as any).grafanaBootData = { user: { login: 'testuser' } };

    mockStreamSession.mockResolvedValue(
      buildSseMockResponse([
        {
          type: 'awaiting_approval',
          tool_name: 'create_silence',
          tool_input: { matchers: [] },
          tool_call_id: 'tc-approve',
        },
      ])
    );

    renderSessionPanel();

    await waitFor(() => {
      expect(screen.getByTestId('approve-button')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('approve-button'));
    });

    await waitFor(() => {
      expect(mockApproveAction).toHaveBeenCalledWith(
        'test-session-id',
        expect.objectContaining({ decision: 'approved', tool_call_id: 'tc-approve' })
      );
    });
  });

  it('FeedbackWidget submits score 1 when thumbs-up clicked', async () => {
    mockStreamSession.mockResolvedValue(
      buildSseMockResponse([{ type: 'done', reason: 'complete' }])
    );

    renderSessionPanel();

    await waitFor(() => {
      expect(screen.getByTestId('session-complete')).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByTestId('feedback-widget')).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByTestId('thumbs-up')[0]);
    fireEvent.click(screen.getByText('Submit'));

    await waitFor(() => {
      expect(mockPostFeedback).toHaveBeenCalledWith(
        'test-session-id',
        expect.objectContaining({ score: 1 })
      );
    });
  });
});

// ---------------------------------------------------------------------------
// EvidencePanel sub-component tests
// ---------------------------------------------------------------------------

describe('EvidencePanel', () => {
  const mockGetDrillDown = require('../services/sessionApi').getDrillDown as jest.Mock;
  const mockGetBackendSrv = require('@grafana/runtime').getBackendSrv as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows permission denied placeholder when datasource query returns 403', async () => {
    mockGetDrillDown.mockResolvedValue({
      handle: 'test-handle',
      tool_name: 'query_metrics',
      full_result: {
        datasource_uid: 'ds-1',
        query_type: 'metrics',
        expr: 'up',
        from_: 'now-1h',
        to: 'now',
      },
      expires_at: '2099-01-01T00:00:00Z',
    });

    // Simulate 403 from datasource query
    const fetchError = Object.assign(new Error('Forbidden'), { status: 403 });
    mockGetBackendSrv.mockReturnValue({
      fetch: jest.fn().mockReturnValue({
        toPromise: jest.fn().mockRejectedValue(fetchError),
      }),
    });

    const { EvidencePanel } = await import('../components/features/Session/EvidencePanel');
    render(<EvidencePanel handle="test-handle" sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getByTestId('evidence-permission-denied')).toBeInTheDocument();
    });
    expect(screen.getByText(/don't have access/i)).toBeInTheDocument();
  });

  it('renders evidence panel on successful datasource query', async () => {
    mockGetDrillDown.mockResolvedValue({
      handle: 'test-handle-2',
      tool_name: 'query_metrics',
      full_result: {
        datasource_uid: 'ds-1',
        query_type: 'metrics',
        expr: 'rate(errors[5m])',
        from_: 'now-1h',
        to: 'now',
      },
      expires_at: '2099-01-01T00:00:00Z',
    });

    mockGetBackendSrv.mockReturnValue({
      fetch: jest.fn().mockReturnValue({
        toPromise: jest.fn().mockResolvedValue({ data: { results: {} } }),
      }),
    });

    const { EvidencePanel } = await import('../components/features/Session/EvidencePanel');
    render(<EvidencePanel handle="test-handle-2" sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getByTestId('evidence-panel')).toBeInTheDocument();
    });
    expect(screen.getByText(/Open in Explore/)).toBeInTheDocument();
  });
});
