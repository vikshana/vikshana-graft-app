'use client';

import { useCallback, useEffect, useState } from 'react';
import type { DashboardStatsFilters, FilterValues } from '@/types/rca';
import { fetchFilterValuesClient } from '@/lib/api';
import { MultiSelect } from '@/components/MultiSelect';

interface DashboardFiltersProps {
  filters: DashboardStatsFilters;
  onChange: (filters: DashboardStatsFilters) => void;
}

/**
 * Dimension-slice multi-selects for the dashboard overview.
 */
export function DashboardFilters({ filters, onChange }: DashboardFiltersProps) {
  const [values, setValues] = useState<FilterValues | null>(null);

  useEffect(() => {
    fetchFilterValuesClient()
      .then(setValues)
      .catch(() => {/* swallow — dropdowns just stay empty */});
  }, []);

  const setField = useCallback(
    <K extends keyof DashboardStatsFilters>(field: K, vals: string[]) => {
      onChange({ ...filters, [field]: vals.length > 0 ? vals : undefined });
    },
    [filters, onChange],
  );

  const hasActive = Object.values(filters).some(v => Array.isArray(v) ? v.length > 0 : Boolean(v));

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="w-36">
        <MultiSelect
          label="Team"
          options={values?.teams ?? []}
          selected={filters.team ?? []}
          onChange={vals => setField('team', vals)}
        />
      </div>
      <div className="w-44">
        <MultiSelect
          label="Service"
          options={values?.services ?? []}
          selected={filters.service_name ?? []}
          onChange={vals => setField('service_name', vals)}
        />
      </div>
      <div className="w-44">
        <MultiSelect
          label="Environment"
          options={values?.environments ?? []}
          selected={filters.deployment_environment_name ?? []}
          onChange={vals => setField('deployment_environment_name', vals)}
        />
      </div>
      <div className="w-36">
        <MultiSelect
          label="Domain"
          options={values?.domains ?? []}
          selected={filters.domain ?? []}
          onChange={vals => setField('domain', vals)}
        />
      </div>
      <div className="w-40">
        <MultiSelect
          label="Sub-Domain"
          options={values?.sub_domains ?? []}
          selected={filters.sub_domain ?? []}
          onChange={vals => setField('sub_domain', vals)}
        />
      </div>
      {hasActive && (
        <button
          onClick={() => onChange({})}
          className="text-xs font-semibold tracking-wider transition-opacity hover:opacity-70 pb-[10px]"
          style={{ color: 'var(--accent)', fontFamily: 'var(--font-mono, monospace)' }}
        >
          CLEAR
        </button>
      )}
    </div>
  );
}
