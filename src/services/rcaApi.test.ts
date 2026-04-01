/**
 * Unit tests for rcaApi.ts
 */

import { parseSseChunk } from './rcaApi';

// ---------------------------------------------------------------------------
// parseSseChunk
// ---------------------------------------------------------------------------

describe('parseSseChunk', () => {
  it('parses a single SSE data line', () => {
    const chunk = 'data: {"type":"step","node":"data_gathering","status":"started"}\n\n';
    const events = parseSseChunk(chunk);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'step', node: 'data_gathering', status: 'started' });
  });

  it('parses multiple SSE data lines in one chunk', () => {
    const chunk = [
      'data: {"type":"step","node":"data_gathering","status":"started"}',
      '',
      'data: {"type":"hypothesis","confidence":0.75}',
      '',
    ].join('\n');

    const events = parseSseChunk(chunk);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('step');
    expect(events[1].type).toBe('hypothesis');
  });

  it('skips non-data lines', () => {
    const chunk = [
      ': ping',
      'event: custom',
      'data: {"type":"done","reason":"complete"}',
      '',
    ].join('\n');

    const events = parseSseChunk(chunk);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('done');
  });

  it('skips malformed JSON lines without throwing', () => {
    const chunk = 'data: not-valid-json\n\ndata: {"type":"done"}\n\n';
    const events = parseSseChunk(chunk);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('done');
  });

  it('returns empty array for empty input', () => {
    expect(parseSseChunk('')).toEqual([]);
  });

  it('returns empty array for chunk with no data lines', () => {
    expect(parseSseChunk(': keep-alive\n\n')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// API call mocking
// ---------------------------------------------------------------------------

jest.mock('@grafana/runtime', () => ({
  getBackendSrv: () => ({
    fetch: jest.fn().mockImplementation((options: { url: string; method: string }) => ({
      toPromise: () =>
        Promise.resolve({
          data: { _url: options.url, _method: options.method },
        }),
    })),
  }),
}));

describe('listRCAs', () => {
  it('calls correct endpoint with no filters', async () => {
    const { listRCAs } = await import('./rcaApi');
    const result = await listRCAs();
    // @ts-ignore — we returned a mock object
    expect(result._url).toContain('/rca?');
    // @ts-ignore — we returned a mock object
    expect(result._method).toBe('GET');
  });

  it('builds correct query string with filters', async () => {
    const { listRCAs } = await import('./rcaApi');
    const result = await listRCAs({ service_name: 'checkout', page: 2, page_size: 10 });
    // @ts-ignore
    expect(result._url).toContain('service_name=checkout');
    // @ts-ignore
    expect(result._url).toContain('page=2');
  });
});

describe('acceptRCA', () => {
  it('posts to the correct accept endpoint', async () => {
    const { acceptRCA } = await import('./rcaApi');
    const result = await acceptRCA('thread-abc');
    // @ts-ignore
    expect(result._url).toContain('/rca/thread-abc/accept');
    // @ts-ignore
    expect(result._method).toBe('POST');
  });
});

describe('getHistory', () => {
  it('calls the history endpoint', async () => {
    const { getHistory } = await import('./rcaApi');
    const result = await getHistory('thread-xyz');
    // @ts-ignore
    expect(result._url).toContain('/rca/thread-xyz/history');
    // @ts-ignore
    expect(result._method).toBe('GET');
  });
});

describe('getStats', () => {
  it('calls the stats endpoint', async () => {
    const { getStats } = await import('./rcaApi');
    const result = await getStats();
    // @ts-ignore
    expect(result._url).toContain('/stats');
  });
});

describe('searchRCAs', () => {
  it('builds correct query string', async () => {
    const { searchRCAs } = await import('./rcaApi');
    const result = await searchRCAs('high error rate', { service: 'checkout', limit: 5 });
    // @ts-ignore
    expect(result._url).toContain('q=high+error+rate');
    // @ts-ignore
    expect(result._url).toContain('service=checkout');
    // @ts-ignore
    expect(result._url).toContain('limit=5');
  });
});

describe('startRCAStream', () => {
  it('calls the start endpoint with correct body', async () => {
    const mockFetch = jest.fn().mockResolvedValue({ ok: true, body: null });
    global.fetch = mockFetch;

    const { startRCAStream } = await import('./rcaApi');
    await startRCAStream({
      alert_context: {
        alert_name: 'HighLatency',
        description: 'P95 > 500ms',
        labels: {},
      },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/rca/start'),
      expect.objectContaining({ method: 'POST' })
    );
    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.alert_context.alert_name).toBe('HighLatency');
  });
});

describe('refineRCAStream', () => {
  it('calls the refine endpoint with correct body', async () => {
    const mockFetch = jest.fn().mockResolvedValue({ ok: true, body: null });
    global.fetch = mockFetch;

    const { refineRCAStream } = await import('./rcaApi');
    await refineRCAStream('thread-abc', 'What was the deployment time?');

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/rca/thread-abc/refine'),
      expect.objectContaining({ method: 'POST' })
    );
    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.message).toBe('What was the deployment time?');
  });
});
