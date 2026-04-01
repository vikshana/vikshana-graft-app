'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { DashboardStats, DashboardStatsFilters, RCASummary } from '@/types/rca';
import { fetchDashboardStatsClient } from '@/lib/api';
import { DashboardFilters } from '@/components/DashboardFilters';
import { StatCard } from '@/components/StatCard';
import { ConfidenceDonut } from '@/components/ConfidenceDonut';
import { ProgressBar } from '@/components/ProgressBar';
import { StatusBadge } from '@/components/StatusBadge';

const POLL_INTERVAL_MS = 5000;

function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function computeConfidencePercent(stats: DashboardStats): number {
  const { high, medium, low, unset } = stats.confidence_breakdown;
  const total = high + medium + low + unset;
  if (total === 0) return 0;
  const score = (high * 100 + medium * 60 + low * 20) / total;
  return Math.round(score);
}

function computeConfidenceTierPercent(
  stats: DashboardStats,
): { highPct: number; mediumPct: number; lowPct: number } {
  const { high, medium, low, unset } = stats.confidence_breakdown;
  const total = high + medium + low + unset;
  if (total === 0) return { highPct: 0, mediumPct: 0, lowPct: 0 };
  return {
    highPct: Math.round((high / total) * 100),
    mediumPct: Math.round((medium / total) * 100),
    lowPct: Math.round((low / total) * 100),
  };
}

export default function DashboardPage() {
  const [filters, setFilters] = useState<DashboardStatsFilters>({});
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = useCallback(async (f: DashboardStatsFilters) => {
    try {
      const result = await fetchDashboardStatsClient(f);
      setStats(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load stats');
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

  if (loading && !stats) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <p className="text-base">Loading dashboard…</p>
      </div>
    );
  }

  if (error && !stats) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
        <p className="text-destructive font-medium">Failed to load dashboard</p>
        <p className="text-destructive/70 text-sm mt-1">{error}</p>
      </div>
    );
  }

  if (!stats) return null;

  const confidencePct = computeConfidencePercent(stats);
  const { highPct, mediumPct, lowPct } = computeConfidenceTierPercent(stats);

  return (
    <div className="space-y-8">
      {/* Filters */}
      <DashboardFilters filters={filters} onChange={setFilters} />

      {/* Stat cards row */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Total Agent Runs"
          value={stats.total_runs.toLocaleString()}
          trendValue={`${stats.investigating_runs} active`}
          trend="up"
        />
        <StatCard
          label="Success Rate"
          value={`${stats.success_rate}%`}
          subtitle={stats.success_rate >= 95 ? 'Optimal performance' : stats.success_rate >= 80 ? 'Good performance' : 'Needs attention'}
          trendValue={stats.success_rate >= 80 ? `+${stats.success_rate}%` : `${stats.success_rate}%`}
          trend={stats.success_rate >= 80 ? 'up' : 'down'}
        />
        <StatCard
          label="Avg Time to RCA"
          value={stats.avg_duration_seconds !== null ? formatDuration(stats.avg_duration_seconds) : '—'}
          subtitle="End-to-end diagnosis latency"
        />
        <StatCard
          label="System Health"
          value="Nominal"
          subtitle={`${stats.investigating_runs} active investigation${stats.investigating_runs !== 1 ? 's' : ''}`}
          trendValue="Operational"
          trend="up"
        />
      </div>

      {/* Bottom section: Confidence + Recent Anomalies */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Report Reliability */}
        <div className="lg:col-span-3 bg-card rounded-lg border border-border p-6">
          <h2 className="font-display text-base font-semibold text-foreground mb-6">
            Report Reliability &amp; Confidence
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div className="space-y-5">
              <ProgressBar label="High Confidence" percentage={highPct} color="green" />
              <ProgressBar label="Medium Confidence" percentage={mediumPct} color="yellow" />
              <ProgressBar label="Low Confidence" percentage={lowPct} color="red" />
            </div>
            <div className="flex flex-col items-center justify-center bg-muted rounded-lg p-6">
              <ConfidenceDonut percentage={confidencePct} />
              <p className="text-xs font-medium text-muted-foreground mt-4">
                Overall Confidence
              </p>
            </div>
          </div>
        </div>

        {/* Recent Anomalies */}
        <div className="lg:col-span-2 bg-card rounded-lg border border-border p-6">
          <h2 className="font-display text-base font-semibold text-foreground mb-4">Recent Anomalies</h2>
          {stats.recent_anomalies.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No anomalies detected
            </p>
          ) : (
            <div className="space-y-1">
              {stats.recent_anomalies.map((rca: RCASummary) => (
                <Link
                  key={rca.id}
                  href={`/rca/${rca.id}`}
                  className="flex items-start gap-3 p-3 rounded-[6px] hover:bg-muted transition-colors"
                >
                  <StatusBadge status={rca.status} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">
                      {rca.alert_name}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {rca.service_name ?? '—'}
                    </p>
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {formatTime(rca.created_at)}
                  </span>
                </Link>
              ))}
            </div>
          )}
          <div className="mt-4 text-center">
            <Link
              href="/rca-runs"
              className="text-sm font-medium text-accent hover:underline"
            >
              View all events →
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
