import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStyles2, LoadingPlaceholder, Alert, Button } from '@grafana/ui';

import { getStats } from '../services/rcaApi';
import { DashboardStats, RCASummary } from '../types/rca.types';
import { prefixRoute } from '../utils/utils.routing';
import { ROUTES } from '../constants';
import { testIds } from '../components/testIds';
import { PageHeader } from '../components/common/PageHeader';
import { getStyles } from './RCADashboard.styles';

export function RCADashboard() {
  const styles = useStyles2(getStyles);
  const navigate = useNavigate();

  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getStats()
      .then(setStats)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className={styles.container} data-testid={testIds.rcaDashboard.container}>
      <PageHeader
        title="Root Cause Analysis"
        backTo=".."
        actions={
          <Button
            variant="secondary"
            fill="outline"
            icon="list-ul"
            onClick={() => navigate(prefixRoute(ROUTES.RcaRuns))}
            data-testid={testIds.rcaDashboard.viewAllButton}
          >
            All RCA runs
          </Button>
        }
      />

      <div className={styles.content}>
        {/* Scoped loading state */}
        {loading && (
          <div className={styles.loadingWrapper}>
            <LoadingPlaceholder text="Loading RCA stats..." />
          </div>
        )}

        {/* Scoped error state */}
        {error && (
          <div className={styles.errorWrapper}>
            <Alert title="Failed to load RCA stats" severity="error">{error}</Alert>
          </div>
        )}

        {stats && (
          <>
            {/* Stat cards */}
            <div className={styles.statsGrid}>
              <StatCard label="Total Runs" value={String(stats.total_runs)} />
              <StatCard label="Success Rate" value={`${stats.success_rate}%`} />
              <StatCard label="Investigating" value={String(stats.investigating_runs)} highlight />
              <StatCard label="Failed" value={String(stats.failed_runs)} />
              <StatCard
                label="Avg Duration"
                value={stats.avg_duration_seconds !== null ? `${stats.avg_duration_seconds}s` : 'N/A'}
              />
            </div>

            {/* Confidence breakdown */}
            <div className={styles.section}>
              <h2 className={styles.subHeading}>Confidence Breakdown</h2>
              <div className={styles.confidenceRow}>
                <ConfidenceBadge label="High" count={stats.confidence_breakdown.high} level="high" />
                <ConfidenceBadge label="Medium" count={stats.confidence_breakdown.medium} level="medium" />
                <ConfidenceBadge label="Low" count={stats.confidence_breakdown.low} level="low" />
                <ConfidenceBadge label="Unset" count={stats.confidence_breakdown.unset} level="unset" />
              </div>
            </div>

            {/* Recent anomalies */}
            {stats.recent_anomalies.length > 0 && (
              <div className={styles.section}>
                <h2 className={styles.subHeading}>Recent Anomalies</h2>
                <table className={styles.table} data-testid={testIds.rcaDashboard.recentAnomaliesTable}>
                   <thead>
                    <tr>
                      <th>Alert</th>
                      <th>Service</th>
                      <th>Status</th>
                      <th>Confidence</th>
                      <th>Created</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.recent_anomalies.map((rca: RCASummary) => (
                      <tr
                        key={rca.id}
                        onClick={() => navigate(prefixRoute(`${ROUTES.RcaInvestigate}/${rca.id}`))}
                      >
                        <td>{rca.alert_name}</td>
                        <td>{rca.service_name ?? '—'}</td>
                        <td>
                          <span className={styles.statusBadge} data-status={rca.status}>
                            {rca.status}
                          </span>
                        </td>
                        <td>{rca.confidence_level ?? '—'}</td>
                        <td>{new Date(rca.created_at).toLocaleString()}</td>
                        <td>
                          <button
                            className={styles.investigateBtn}
                            onClick={(e) => {
                              e.stopPropagation();
                              navigate(prefixRoute(`${ROUTES.RcaInvestigate}/${rca.id}`));
                            }}
                          >
                            Investigate →
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatCard({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  const styles = useStyles2(getStyles);
  return (
    <div className={highlight ? styles.statCardHighlight : styles.statCard}>
      <div className={styles.statValue}>{value}</div>
      <div className={styles.statLabel}>{label}</div>
    </div>
  );
}

type ConfidenceLevel = 'high' | 'medium' | 'low' | 'unset';

function ConfidenceBadge({ label, count, level }: { label: string; count: number; level: ConfidenceLevel }) {
  const styles = useStyles2(getStyles);
  return (
    <div className={styles.confidenceBadge} data-level={level}>
      <span className={styles.confidenceCount}>{count}</span>
      <span className={styles.confidenceLabel}>{label}</span>
    </div>
  );
}
