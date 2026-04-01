import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { RCAList } from './RCAList';
import * as rcaApi from '../services/rcaApi';
import { RCAListResponse } from '../types/rca.types';

jest.mock('../services/rcaApi');

const mockListResponse: RCAListResponse = {
  items: [
    {
      id: 'rca-001',
      alert_name: 'HighLatency',
      status: 'complete',
      confidence_level: 'high',
      service_name: 'checkout-service',
      deployment_environment_name: 'production',
      created_at: '2024-01-15T14:00:00Z',
      completed_at: '2024-01-15T14:05:00Z',
      duration_seconds: 300,
    },
    {
      id: 'rca-002',
      alert_name: 'HighErrorRate',
      status: 'failed',
      confidence_level: null,
      service_name: 'payment-service',
      deployment_environment_name: 'staging',
      created_at: '2024-01-14T09:00:00Z',
      completed_at: null,
      duration_seconds: null,
    },
  ],
  total: 2,
  page: 1,
  page_size: 20,
};

describe('RCAList', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows loading placeholder initially', () => {
    (rcaApi.listRCAs as jest.Mock).mockImplementation(() => new Promise(() => {}));
    render(
      <MemoryRouter>
        <RCAList />
      </MemoryRouter>
    );
    expect(screen.getByText(/loading rca runs/i)).toBeInTheDocument();
  });

  it('renders table with correct columns', async () => {
    (rcaApi.listRCAs as jest.Mock).mockResolvedValue(mockListResponse);
    render(
      <MemoryRouter>
        <RCAList />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('HighLatency')).toBeInTheDocument();
      expect(screen.getByText('HighErrorRate')).toBeInTheDocument();
      expect(screen.getByText('checkout-service')).toBeInTheDocument();
      expect(screen.getByText('payment-service')).toBeInTheDocument();
    });
  });

  it('renders Investigate link for each row', async () => {
    (rcaApi.listRCAs as jest.Mock).mockResolvedValue(mockListResponse);
    render(
      <MemoryRouter>
        <RCAList />
      </MemoryRouter>
    );

    await waitFor(() => {
      const investigateLinks = screen.getAllByText(/investigate/i);
      expect(investigateLinks).toHaveLength(2);
    });
  });

  it('triggers new API call when alert_name filter changes', async () => {
    (rcaApi.listRCAs as jest.Mock).mockResolvedValue(mockListResponse);
    render(
      <MemoryRouter>
        <RCAList />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('HighLatency')).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(/search by alert name/i);
    fireEvent.change(searchInput, { target: { value: 'High' } });

    // Should trigger a new fetch
    await waitFor(() => {
      expect(rcaApi.listRCAs).toHaveBeenCalledTimes(2);
      const secondCall = (rcaApi.listRCAs as jest.Mock).mock.calls[1][0];
      expect(secondCall.alert_name).toBe('High');
    });
  });

  it('shows empty state when no results', async () => {
    (rcaApi.listRCAs as jest.Mock).mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      page_size: 20,
    });
    render(
      <MemoryRouter>
        <RCAList />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/no rca runs found/i)).toBeInTheDocument();
    });
  });

  it('shows pagination controls when multiple pages exist', async () => {
    (rcaApi.listRCAs as jest.Mock).mockResolvedValue({
      ...mockListResponse,
      total: 45,
      page_size: 20,
    });
    render(
      <MemoryRouter>
        <RCAList />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/next/i)).toBeInTheDocument();
      expect(screen.getByText(/prev/i)).toBeInTheDocument();
    });
  });

  it('shows error alert on API failure', async () => {
    (rcaApi.listRCAs as jest.Mock).mockRejectedValue(new Error('Server error'));
    render(
      <MemoryRouter>
        <RCAList />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/failed to load rcas/i)).toBeInTheDocument();
    });
  });
});
