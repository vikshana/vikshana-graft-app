import React from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { RCAInvestigate } from './RCAInvestigate';
import * as rcaApi from '../services/rcaApi';
import { RCAHistoryResponse } from '../types/rca.types';

jest.mock('../services/rcaApi');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockHistoryAwaitingInput: RCAHistoryResponse = {
  thread_id: 'thread-abc',
  round: 0,
  hypotheses: [
    {
      text: 'DB connection pool exhaustion caused by memory leak in connection handler.',
      high_confidence_areas: ['error rate', 'database connections'],
      uncertain_areas: ['root trigger', 'deployment correlation'],
      suggested_questions: ['When was the last deployment?', 'Are there any DB alerts?'],
    },
  ],
  confidence_scores: [0.75],
  qa_transcript: [],
  final_report: null,
  rca_session_id: null,
  developer_accepted: false,
  force_finalized: false,
};

function renderInvestigate(threadId: string) {
  return render(
    <MemoryRouter initialEntries={[`/rca/investigate/${threadId}`]}>
      <Routes>
        <Route path="/rca/investigate/:threadId" element={<RCAInvestigate />} />
      </Routes>
    </MemoryRouter>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RCAInvestigate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('loads and displays hypothesis for existing thread', async () => {
    (rcaApi.getHistory as jest.Mock).mockResolvedValue(mockHistoryAwaitingInput);

    renderInvestigate('thread-abc');

    await waitFor(() => {
      expect(screen.getByText(/DB connection pool exhaustion/i)).toBeInTheDocument();
    });
  });

  it('renders suggested questions as clickable chips', async () => {
    (rcaApi.getHistory as jest.Mock).mockResolvedValue(mockHistoryAwaitingInput);

    renderInvestigate('thread-abc');

    await waitFor(() => {
      expect(screen.getByText('When was the last deployment?')).toBeInTheDocument();
      expect(screen.getByText('Are there any DB alerts?')).toBeInTheDocument();
    });
  });

  it('clicking a suggested question fills the input', async () => {
    (rcaApi.getHistory as jest.Mock).mockResolvedValue(mockHistoryAwaitingInput);

    renderInvestigate('thread-abc');

    await waitFor(() => {
      expect(screen.getByText('When was the last deployment?')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('When was the last deployment?'));

    const textarea = screen.getByPlaceholderText(/ask a follow-up question/i);
    expect((textarea as HTMLTextAreaElement).value).toBe('When was the last deployment?');
  });

  it('Accept button is present when awaiting input', async () => {
    (rcaApi.getHistory as jest.Mock).mockResolvedValue(mockHistoryAwaitingInput);

    renderInvestigate('thread-abc');

    await waitFor(() => {
      expect(screen.getByText(/accept as final rca/i)).toBeInTheDocument();
    });
  });

  it('shows accept confirmation warning on low-confidence accept', async () => {
    (rcaApi.getHistory as jest.Mock).mockResolvedValue({
      ...mockHistoryAwaitingInput,
      confidence_scores: [0.4], // below 0.6 threshold
    });

    renderInvestigate('thread-abc');

    await waitFor(() => {
      expect(screen.getByText(/accept as final rca/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText(/accept as final rca/i));

    await waitFor(() => {
      expect(screen.getByText(/low confidence/i)).toBeInTheDocument();
    });
  });

  it('completes and shows final report after second accept click', async () => {
    (rcaApi.getHistory as jest.Mock).mockResolvedValue({
      ...mockHistoryAwaitingInput,
      confidence_scores: [0.45],
    });

    (rcaApi.acceptRCA as jest.Mock).mockResolvedValue({
      thread_id: 'thread-abc',
      rca_session_id: 'session-xyz',
      final_report: {
        executive_summary: 'DB pool was exhausted due to a connection leak.',
        root_cause: 'Memory leak in connection handler.',
        recommendations: ['Upgrade driver', 'Add connection pool monitoring'],
      },
      developer_override: true,
    });

    renderInvestigate('thread-abc');

    await waitFor(() => {
      expect(screen.getByText(/accept as final rca/i)).toBeInTheDocument();
    });

    // First click shows warning
    fireEvent.click(screen.getByText(/accept as final rca/i));
    await waitFor(() => {
      expect(screen.getByText(/low confidence/i)).toBeInTheDocument();
    });

    // Second click confirms
    fireEvent.click(screen.getByText(/accept as final rca/i));
    await waitFor(() => {
      expect(screen.getByText(/Final RCA Report/i)).toBeInTheDocument();
      expect(screen.getByText(/DB pool was exhausted/i)).toBeInTheDocument();
    });
  });

  it('shows Q&A transcript from history', async () => {
    (rcaApi.getHistory as jest.Mock).mockResolvedValue({
      ...mockHistoryAwaitingInput,
      hypotheses: [
        {
          text: 'DB connection pool exhaustion caused by memory leak in connection handler.',
          high_confidence_areas: [],
          uncertain_areas: [],
          suggested_questions: [], // no chips — avoids text collision with transcript
        },
      ],
      qa_transcript: [
        { role: 'developer', content: 'How long has memory been climbing?' },
        { role: 'agent', content: 'Memory usage has grown by 40% in the past 2 hours.' },
      ],
    });

    renderInvestigate('thread-abc');

    await waitFor(() => {
      expect(screen.getByText('How long has memory been climbing?')).toBeInTheDocument();
      expect(screen.getByText('Memory usage has grown by 40% in the past 2 hours.')).toBeInTheDocument();
    });
  });

  it('shows high/low confidence areas from hypothesis', async () => {
    (rcaApi.getHistory as jest.Mock).mockResolvedValue(mockHistoryAwaitingInput);

    renderInvestigate('thread-abc');

    await waitFor(() => {
      expect(screen.getByText('error rate')).toBeInTheDocument();
      expect(screen.getByText('root trigger')).toBeInTheDocument();
    });
  });

  it('shows final report if thread is already complete', async () => {
    (rcaApi.getHistory as jest.Mock).mockResolvedValue({
      ...mockHistoryAwaitingInput,
      final_report: {
        executive_summary: 'Already completed RCA.',
        root_cause: 'Known cause.',
        recommendations: [],
      },
      developer_accepted: true,
    });

    renderInvestigate('thread-abc');

    await waitFor(() => {
      expect(screen.getByText(/Final RCA Report/i)).toBeInTheDocument();
      expect(screen.getByText('Already completed RCA.')).toBeInTheDocument();
    });
  });
});
