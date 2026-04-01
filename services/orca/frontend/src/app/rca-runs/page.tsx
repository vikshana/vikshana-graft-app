'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RCAFilters, RCAListResponse } from '@/types/rca';
import { fetchRCAListClient } from '@/lib/api';
import { FilterBar } from '@/components/FilterBar';
import { RCATable } from '@/components/RCATable';

const POLL_INTERVAL_MS = 5000;

export default function AgentRunsPage() {
  const [filters, setFilters] = useState<RCAFilters>({ page: 1, page_size: 20 });
  const [data, setData] = useState<RCAListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = useCallback(async (currentFilters: RCAFilters) => {
    try {
      const result = await fetchRCAListClient(currentFilters);
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load RCAs');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchData(filters);
    intervalRef.current = setInterval(() => fetchData(filters), POLL_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [filters, fetchData]);

  const handleFiltersChange = useCallback((newFilters: RCAFilters) => {
    setFilters(newFilters);
  }, []);

  const handlePageChange = useCallback((newPage: number) => {
    setFilters((prev) => ({ ...prev, page: newPage }));
  }, []);

  return (
    <div className="space-y-6">
      {/* Filters */}
      <FilterBar filters={filters} onChange={handleFiltersChange} />

      {/* Content */}
      {loading && !data ? (
        <div className="text-center py-16 text-muted-foreground">
          <p className="text-base">Loading agent runs…</p>
        </div>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
          <p className="text-destructive font-medium">Failed to load agent runs</p>
          <p className="text-destructive/70 text-sm mt-1">{error}</p>
        </div>
      ) : data ? (
        <RCATable
          items={data.items}
          total={data.total}
          page={data.page}
          pageSize={data.page_size}
          filters={filters}
          onPageChange={handlePageChange}
        />
      ) : null}
    </div>
  );
}

