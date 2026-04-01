'use client';

import { useCallback, useEffect, useState } from 'react';
import type { RCAFilters, RCAStatus, FilterValues } from '@/types/rca';
import { fetchFilterValuesClient } from '@/lib/api';
import { MultiSelect } from '@/components/MultiSelect';

interface FilterBarProps {
  filters: RCAFilters;
  onChange: (filters: RCAFilters) => void;
}

const ALL_STATUSES: RCAStatus[] = ['triggered', 'investigating', 'complete', 'failed'];

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '10px',
  fontWeight: 600,
  letterSpacing: '0.1em',
  textTransform: 'uppercase' as const,
  color: 'var(--muted-foreground)',
  marginBottom: '6px',
  fontFamily: 'var(--font-mono, monospace)',
};

/**
 * Filter bar for the RCA Runs page — text search + searchable multi-selects.
 */
export function FilterBar({ filters, onChange }: FilterBarProps) {
  const [values, setValues] = useState<FilterValues | null>(null);

  useEffect(() => {
    fetchFilterValuesClient()
      .then(setValues)
      .catch(() => {/* swallow */});
  }, []);

  const setField = useCallback(
    <K extends keyof RCAFilters>(field: K, value: RCAFilters[K]) => {
      const isEmpty =
        value === undefined ||
        value === '' ||
        (Array.isArray(value) && value.length === 0);
      onChange({ ...filters, [field]: isEmpty ? undefined : value, page: 1 });
    },
    [filters, onChange],
  );

  const hasActiveFilters =
    (filters.alert_name ?? '') !== '' ||
    (filters.status?.length ?? 0) > 0 ||
    (filters.team?.length ?? 0) > 0 ||
    (filters.service_name?.length ?? 0) > 0;

  return (
    <div className="rounded-xl border border-border p-5" style={{ background: 'var(--card)' }}>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {/* Alert name text search */}
        <div>
          <label style={labelStyle}>Alert Name</label>
          <div className="relative">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 pointer-events-none"
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
              style={{ color: 'var(--muted-foreground)' }}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
            </svg>
            <input
              type="text"
              placeholder="e.g. Memory Spike"
              value={filters.alert_name ?? ''}
              onChange={e => setField('alert_name', e.target.value || undefined)}
              style={{
                height: '36px',
                paddingLeft: '32px',
                paddingRight: '12px',
                fontSize: '13px',
                background: 'var(--input)',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                color: 'var(--foreground)',
                width: '100%',
                outline: 'none',
              }}
            />
          </div>
        </div>

        {/* Status multi-select */}
        <div>
          <label style={labelStyle}>Status</label>
          <MultiSelect
            label="Status"
            options={ALL_STATUSES}
            selected={filters.status ?? []}
            onChange={vals => setField('status', vals as RCAStatus[])}
          />
        </div>

        {/* Team multi-select */}
        <div>
          <label style={labelStyle}>Team</label>
          <MultiSelect
            label="Team"
            options={values?.teams ?? []}
            selected={filters.team ?? []}
            onChange={vals => setField('team', vals)}
          />
        </div>

        {/* Service multi-select */}
        <div>
          <label style={labelStyle}>Service</label>
          <MultiSelect
            label="Service"
            options={values?.services ?? []}
            selected={filters.service_name ?? []}
            onChange={vals => setField('service_name', vals)}
          />
        </div>
      </div>

      {hasActiveFilters && (
        <div className="flex justify-end mt-3">
          <button
            onClick={() => onChange({ page: 1, page_size: 20 })}
            className="text-xs font-semibold tracking-wider transition-opacity hover:opacity-70"
            style={{ color: 'var(--accent)', fontFamily: 'var(--font-mono, monospace)' }}
          >
            CLEAR ALL
          </button>
        </div>
      )}
    </div>
  );
}
