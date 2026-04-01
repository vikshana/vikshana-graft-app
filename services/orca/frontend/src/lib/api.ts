/**
 * Typed API client for the Orca backend.
 * Uses NEXT_PUBLIC_API_URL or falls back to the Next.js rewrite proxy.
 */

import type {
  DashboardStats,
  DashboardStatsFilters,
  FeedbackPayload,
  FilterValues,
  RCADetail,
  RCAFilters,
  RCAListResponse,
} from '@/types/rca';

const API_BASE =
  typeof window !== 'undefined'
    ? ''
    : process.env.BACKEND_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

function buildQueryString(filters: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length > 0) params.set(key, value.join(','));
    } else {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/**
 * Fetch a paginated list of RCAs with optional filters.
 */
export async function fetchRCAList(filters: RCAFilters = {}): Promise<RCAListResponse> {
  const url = `${API_BASE}/api/rca${buildQueryString(filters)}`;
  const response = await fetch(url, {
    next: { revalidate: 5 },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch RCA list: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<RCAListResponse>;
}

/**
 * Fetch a single RCA by ID with full detail (report + agent steps).
 */
export async function fetchRCADetail(id: string): Promise<RCADetail> {
  const url = `${API_BASE}/api/rca/${id}`;
  const response = await fetch(url, {
    next: { revalidate: 0 },
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`RCA not found: ${id}`);
    }
    throw new Error(`Failed to fetch RCA detail: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<RCADetail>;
}

/**
 * Fetch a single RCA by ID (client-side, no caching).
 */
export async function fetchRCADetailClient(id: string): Promise<RCADetail> {
  const url = `/api/rca/${id}`;
  const response = await fetch(url);

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`RCA not found: ${id}`);
    }
    throw new Error(`Failed to fetch RCA detail: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<RCADetail>;
}

/**
 * Fetch RCA list (client-side, no caching).
 */
export async function fetchRCAListClient(filters: RCAFilters = {}): Promise<RCAListResponse> {
  const url = `/api/rca${buildQueryString(filters)}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to fetch RCA list: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<RCAListResponse>;
}

/**
 * Fetch aggregate dashboard statistics with optional dimension slicing.
 */
export async function fetchDashboardStats(
  filters: DashboardStatsFilters = {}
): Promise<DashboardStats> {
  const url = `${API_BASE}/api/stats${buildQueryString(filters)}`;
  const response = await fetch(url, {
    next: { revalidate: 5 },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch dashboard stats: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<DashboardStats>;
}

/**
 * Fetch dashboard statistics (client-side, no caching).
 */
export async function fetchDashboardStatsClient(
  filters: DashboardStatsFilters = {}
): Promise<DashboardStats> {
  const url = `/api/stats${buildQueryString(filters)}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to fetch dashboard stats: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<DashboardStats>;
}

/**
 * Fetch distinct filter values for dropdown population.
 */
export async function fetchFilterValues(): Promise<FilterValues> {
  const url = `${API_BASE}/api/filters/values`;
  const response = await fetch(url, {
    next: { revalidate: 30 },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch filter values: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<FilterValues>;
}

/**
 * Fetch distinct filter values (client-side, no caching).
 */
export async function fetchFilterValuesClient(): Promise<FilterValues> {
  const url = `/api/filters/values`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to fetch filter values: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<FilterValues>;
}

/**
 * Submit user feedback (thumbs up/down + comment) for an RCA.
 */
export async function submitFeedback(id: string, payload: FeedbackPayload): Promise<RCADetail> {
  const url = `/api/rca/${id}/feedback`;
  const response = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Failed to submit feedback: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<RCADetail>;
}

