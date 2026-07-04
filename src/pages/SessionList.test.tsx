import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

jest.mock('../services/sessionApi', () => ({
  listSessions: jest.fn(),
  postTurn: jest.fn(),
  approveAction: jest.fn(),
  postFeedback: jest.fn(),
  getDrillDown: jest.fn(),
  streamSession: jest.fn(),
  parseSseChunk: jest.requireActual('../services/sessionApi').parseSseChunk,
}));

const mockListSessions = require('../services/sessionApi').listSessions as jest.Mock;

describe('SessionList', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders sessions returned by listSessions', async () => {
    mockListSessions.mockResolvedValue({
      sessions: [
        {
          id: 'aaaaaaaa-0000-0000-0000-000000000001',
          type: 'investigation',
          status: 'active',
          alert_type: 'HighErrorRate',
          service: 'checkout-service',
          auth_mode: 'service_account',
          created_at: '2024-01-15T14:47:00Z',
        },
      ],
      total: 1,
    });

    const { SessionList } = await import('./SessionList');
    render(
      <MemoryRouter>
        <SessionList />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/HighErrorRate/)).toBeInTheDocument();
    });
    expect(screen.getByText('checkout-service')).toBeInTheDocument();
    expect(screen.getByText('1 session')).toBeInTheDocument();
  });

  it('renders empty state when no sessions exist', async () => {
    mockListSessions.mockResolvedValue({ sessions: [], total: 0 });
    const { SessionList } = await import('./SessionList');
    render(
      <MemoryRouter>
        <SessionList />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByTestId('sessions-empty')).toBeInTheDocument();
    });
  });

  it('renders error state on API failure', async () => {
    mockListSessions.mockRejectedValue(new Error('Network error'));
    const { SessionList } = await import('./SessionList');
    render(
      <MemoryRouter>
        <SessionList />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByText(/Failed to load sessions/)).toBeInTheDocument();
    });
  });
});
