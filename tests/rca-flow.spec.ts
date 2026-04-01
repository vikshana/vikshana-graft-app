/**
 * Playwright E2E tests for the RCA investigation flow.
 *
 * These tests mock the ORCA backend API responses so they run without a real
 * ORCA instance.  They verify:
 * 1. Navigation to RCA dashboard and list pages
 * 2. Starting an RCA and consuming the SSE stream
 * 3. Q&A interaction (refine) and final accept flow
 *
 * Run: npm run e2e
 */

import { test, expect } from './fixtures';

const PLUGIN_ID = 'vikshana-graft-app';
const BASE_PATH = `/a/${PLUGIN_ID}`;

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** SSE events as a newline-separated string for mocking the /start endpoint. */
function buildSseBody(events: Array<Record<string, unknown>>): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

// ---------------------------------------------------------------------------
// RCA Dashboard
// ---------------------------------------------------------------------------

test.describe('RCA Dashboard', () => {
  test('navigates to /rca and shows dashboard', async ({ page, gotoPage }) => {
    // Mock the stats endpoint
    await page.route('**/api/plugins/**/resources/rca/api/stats', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          total_runs: 15,
          completed_runs: 12,
          failed_runs: 1,
          investigating_runs: 2,
          success_rate: 92.3,
          avg_duration_seconds: 240,
          confidence_breakdown: { high: 8, medium: 3, low: 1, unset: 3 },
          status_breakdown: { triggered: 0, investigating: 2, complete: 12, failed: 1 },
          recent_anomalies: [],
        }),
      });
    });

    await gotoPage('/rca');

    await expect(page.getByText('Root Cause Analysis')).toBeVisible();
    await expect(page.getByText('15')).toBeVisible(); // total_runs
    await expect(page.getByText('92.3%')).toBeVisible(); // success_rate
  });

  test('shows confidence breakdown section', async ({ page, gotoPage }) => {
    await page.route('**/api/plugins/**/resources/rca/api/stats', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          total_runs: 5,
          completed_runs: 5,
          failed_runs: 0,
          investigating_runs: 0,
          success_rate: 100,
          avg_duration_seconds: null,
          confidence_breakdown: { high: 3, medium: 1, low: 1, unset: 0 },
          status_breakdown: { triggered: 0, investigating: 0, complete: 5, failed: 0 },
          recent_anomalies: [],
        }),
      });
    });

    await gotoPage('/rca');

    await expect(page.getByText('Confidence Breakdown')).toBeVisible();
    await expect(page.getByText('High')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// RCA List
// ---------------------------------------------------------------------------

test.describe('RCA List', () => {
  test('navigates to /rca/runs and shows table', async ({ page, gotoPage }) => {
    await page.route('**/api/plugins/**/resources/rca/api/rca*', async (route) => {
      const url = route.request().url();
      // Skip the /search sub-route
      if (url.includes('/search')) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              id: 'rca-e2e-001',
              alert_name: 'HighLatencyE2E',
              status: 'complete',
              confidence_level: 'high',
              service_name: 'checkout-service',
              deployment_environment_name: 'production',
              created_at: new Date().toISOString(),
              completed_at: new Date().toISOString(),
              duration_seconds: 180,
            },
          ],
          total: 1,
          page: 1,
          page_size: 20,
        }),
      });
    });

    await gotoPage('/rca/runs');

    await expect(page.getByText('RCA History')).toBeVisible();
    await expect(page.getByText('HighLatencyE2E')).toBeVisible();
    await expect(page.getByText('checkout-service')).toBeVisible();
  });

  test('investigate link navigates to thread page', async ({ page, gotoPage }) => {
    await page.route('**/api/plugins/**/resources/rca/api/rca*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              id: 'thread-e2e-001',
              alert_name: 'E2EAlert',
              status: 'complete',
              confidence_level: 'high',
              service_name: 'api-service',
              deployment_environment_name: 'production',
              created_at: new Date().toISOString(),
              completed_at: null,
              duration_seconds: null,
            },
          ],
          total: 1,
          page: 1,
          page_size: 20,
        }),
      });
    });

    // Mock the history endpoint for the thread
    await page.route('**/api/plugins/**/resources/rca/api/rca/thread-e2e-001/history', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          thread_id: 'thread-e2e-001',
          round: 1,
          hypotheses: [
            {
              text: 'Memory leak in connection pool',
              high_confidence_areas: ['error rate'],
              uncertain_areas: [],
              suggested_questions: [],
            },
          ],
          confidence_scores: [0.8],
          qa_transcript: [],
          final_report: null,
          rca_session_id: null,
          developer_accepted: false,
          force_finalized: false,
        }),
      });
    });

    await gotoPage('/rca/runs');
    await expect(page.getByText('E2EAlert')).toBeVisible();

    await page.getByText(/investigate/i).first().click();

    // Should navigate to the investigate page
    await expect(page).toHaveURL(/rca\/investigate\/thread-e2e-001/);
  });
});

// ---------------------------------------------------------------------------
// RCA Investigate — SSE streaming flow
// ---------------------------------------------------------------------------

test.describe('RCA Investigate', () => {
  test('loads existing thread and shows hypothesis', async ({ page, gotoPage }) => {
    await page.route(
      '**/api/plugins/**/resources/rca/api/rca/thread-test-001/history',
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            thread_id: 'thread-test-001',
            round: 1,
            hypotheses: [
              {
                text: 'Database connection pool is exhausted due to connection leak.',
                high_confidence_areas: ['error rate', 'connections'],
                uncertain_areas: ['root trigger'],
                suggested_questions: ['When was last deployment?', 'DB pool size?'],
              },
            ],
            confidence_scores: [0.78],
            qa_transcript: [],
            final_report: null,
            rca_session_id: null,
            developer_accepted: false,
            force_finalized: false,
          }),
        });
      }
    );

    await gotoPage('/rca/investigate/thread-test-001');

    await expect(page.getByText(/Database connection pool is exhausted/i)).toBeVisible();
    await expect(page.getByText('78% confidence')).toBeVisible();
    await expect(page.getByText('When was last deployment?')).toBeVisible();
  });

  test('send button submits developer question', async ({ page, gotoPage }) => {
    // Mock history with awaiting_input state
    await page.route(
      '**/api/plugins/**/resources/rca/api/rca/thread-qa-001/history',
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            thread_id: 'thread-qa-001',
            round: 1,
            hypotheses: [
              {
                text: 'Memory leak hypothesis',
                high_confidence_areas: [],
                uncertain_areas: [],
                suggested_questions: [],
              },
            ],
            confidence_scores: [0.65],
            qa_transcript: [],
            final_report: null,
            rca_session_id: null,
            developer_accepted: false,
            force_finalized: false,
          }),
        });
      }
    );

    // Mock the refine SSE stream
    const sseBody = buildSseBody([
      { type: 'step', node: 'refine', status: 'started' },
      {
        type: 'hypothesis',
        hypothesis: {
          text: 'Refined: memory leak confirmed',
          high_confidence_areas: ['memory usage'],
          uncertain_areas: [],
          suggested_questions: [],
        },
        confidence: 0.88,
      },
      {
        type: 'interrupt',
        thread_id: 'thread-qa-001',
        hypothesis: {
          text: 'Refined: memory leak confirmed',
          high_confidence_areas: [],
          uncertain_areas: [],
          suggested_questions: [],
        },
        confidence: 0.88,
        round: 2,
        suggested_questions: [],
      },
      { type: 'done', reason: 'awaiting_input' },
    ]);

    await page.route(
      '**/api/plugins/**/resources/rca/api/rca/thread-qa-001/refine',
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: sseBody,
        });
      }
    );

    await gotoPage('/rca/investigate/thread-qa-001');

    await expect(page.getByText('Memory leak hypothesis')).toBeVisible();

    const textarea = page.getByPlaceholderText(/ask a follow-up question/i);
    await textarea.fill('How long has memory been growing?');
    await page.getByRole('button', { name: /send/i }).click();

    // The new hypothesis should appear after the stream completes
    await expect(page.getByText(/Refined: memory leak confirmed/i)).toBeVisible({ timeout: 5000 });
  });

  test('accept button calls accept API and shows final report', async ({ page, gotoPage }) => {
    await page.route(
      '**/api/plugins/**/resources/rca/api/rca/thread-accept-001/history',
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            thread_id: 'thread-accept-001',
            round: 1,
            hypotheses: [
              {
                text: 'High-confidence root cause identified.',
                high_confidence_areas: ['everything'],
                uncertain_areas: [],
                suggested_questions: [],
              },
            ],
            confidence_scores: [0.92],
            qa_transcript: [],
            final_report: null,
            rca_session_id: null,
            developer_accepted: false,
            force_finalized: false,
          }),
        });
      }
    );

    await page.route(
      '**/api/plugins/**/resources/rca/api/rca/thread-accept-001/accept',
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            thread_id: 'thread-accept-001',
            rca_session_id: 'session-final-001',
            final_report: {
              executive_summary: 'The root cause was identified as a DB connection leak.',
              root_cause: 'Unreleased connections in the ORM layer.',
              recommendations: ['Upgrade ORM', 'Add connection pool monitoring'],
            },
            developer_override: false,
          }),
        });
      }
    );

    await gotoPage('/rca/investigate/thread-accept-001');

    await expect(page.getByText('High-confidence root cause identified.')).toBeVisible();
    await expect(page.getByText(/accept as final rca/i)).toBeVisible();

    // Click accept — confidence is high (0.92) so no warning
    await page.getByRole('button', { name: /accept as final rca/i }).click();

    await expect(page.getByText(/Final RCA Report/i)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/DB connection leak/i)).toBeVisible();
  });
});
