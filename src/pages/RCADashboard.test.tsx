import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { RCADashboard } from './RCADashboard';
import * as rcaApi from '../services/rcaApi';
import { DashboardStats } from '../types/rca.types';

jest.mock('../services/rcaApi');

const mockStats: DashboardStats = {
  total_runs: 42,
  completed_runs: 38,
  failed_runs: 2,
  investigating_runs: 2,
  success_rate: 95.0,
  avg_duration_seconds: 180,
  confidence_breakdown: { high: 20, medium: 12, low: 6, unset: 4 },
  status_breakdown: { triggered: 0, investigating: 2, complete: 38, failed: 2 },
  recent_anomalies: [
    {
      id: 'rca-001',
      alert_name: 'HighLatency',
      status: 'failed',
      confidence_level: 'low',
      service_name: 'checkout-service',
      deployment_environment_name: 'production',
      created_at: '2024-01-15T14:00:00Z',
      completed_at: null,
      duration_seconds: null,
    },
  ],
};

describe('RCADashboard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows loading placeholder initially', () => {
    (rcaApi.getStats as jest.Mock).mockImplementation(() => new Promise(() => {}));
    render(
      <MemoryRouter>
        <RCADashboard />
      </MemoryRouter>
    );
    expect(screen.getByText(/loading rca stats/i)).toBeInTheDocument();
  });

  it('renders stat cards with API data', async () => {
    (rcaApi.getStats as jest.Mock).mockResolvedValue(mockStats);
    render(
      <MemoryRouter>
        <RCADashboard />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('42')).toBeInTheDocument(); // total_runs
      expect(screen.getByText('95%')).toBeInTheDocument(); // success_rate
    });
  });

  it('renders confidence breakdown', async () => {
    (rcaApi.getStats as jest.Mock).mockResolvedValue(mockStats);
    render(
      <MemoryRouter>
        <RCADashboard />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('High')).toBeInTheDocument();
      expect(screen.getByText('Medium')).toBeInTheDocument();
      expect(screen.getByText('Low')).toBeInTheDocument();
    });
  });

  it('renders recent anomalies table', async () => {
    (rcaApi.getStats as jest.Mock).mockResolvedValue(mockStats);
    render(
      <MemoryRouter>
        <RCADashboard />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('HighLatency')).toBeInTheDocument();
      expect(screen.getByText('checkout-service')).toBeInTheDocument();
    });
  });

  it('shows error alert on API failure', async () => {
    (rcaApi.getStats as jest.Mock).mockRejectedValue(new Error('Network error'));
    render(
      <MemoryRouter>
        <RCADashboard />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/failed to load rca stats/i)).toBeInTheDocument();
    });
  });
});
