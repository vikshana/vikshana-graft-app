import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { css } from '@emotion/css';
import { useStyles2, LoadingPlaceholder, Alert } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';

import { getStats } from '../services/rcaApi';
import { DashboardStats, RCASummary } from '../types/rca.types';
import { prefixRoute } from '../utils/utils.routing';
import { ROUTES } from '../constants';

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

  if (loading) {
    return <LoadingPlaceholder text="Loading RCA stats..." />;
  }

  if (error) {
    return <Alert title="Failed to load RCA stats" severity="error">{error}</Alert>;
  }

  if (!stats) {
    return null;
  }

  const { total_runs, failed_runs, investigating_runs, success_rate, avg_duration_seconds, confidence_breakdown, recent_anomalies } = stats;

  return (
    <div className={styles.container}>
      <h1 className={styles.heading}>Root Cause Analysis</h1>

      {/* Stat cards */}
      <div className={styles.statsGrid}>
        <StatCard label="Total Runs" value={String(total_runs)} />
        <StatCard label="Success Rate" value={`${success_rate}%`} />
        <StatCard label="Investigating" value={String(investigating_runs)} highlight />
        <StatCard label="Failed" value={String(failed_runs)} />
        <StatCard
          label="Avg Duration"
          value={avg_duration_seconds !== null ? `${avg_duration_seconds}s` : 'N/A'}
        />
      </div>

      {/* Confidence breakdown */}
      <div className={styles.section}>
        <h2 className={styles.subHeading}>Confidence Breakdown</h2>
        <div className={styles.confidenceRow}>
          <ConfidenceBadge label="High" count={confidence_breakdown.high} color="green" />
          <ConfidenceBadge label="Medium" count={confidence_breakdown.medium} color="orange" />
          <ConfidenceBadge label="Low" count={confidence_breakdown.low} color="red" />
          <ConfidenceBadge label="Unset" count={confidence_breakdown.unset} color="grey" />
        </div>
      </div>

      {/* Recent anomalies */}
      {recent_anomalies.length > 0 && (
        <div className={styles.section}>
          <h2 className={styles.subHeading}>Recent Anomalies</h2>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Alert</th>
                <th>Service</th>
                <th>Status</th>
                <th>Confidence</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {recent_anomalies.map((rca: RCASummary) => (
                <tr key={rca.id}>
                  <td>{rca.alert_name}</td>
                  <td>{rca.service_name ?? '—'}</td>
                  <td>{rca.status}</td>
                  <td>{rca.confidence_level ?? '—'}</td>
                  <td>{new Date(rca.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Navigation */}
      <div className={styles.actions}>
        <button className={styles.linkButton} onClick={() => navigate(prefixRoute(ROUTES.RcaRuns))}>
          View all RCA runs →
        </button>
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

function ConfidenceBadge({ label, count, color }: { label: string; count: number; color: string }) {
  const styles = useStyles2(getStyles);
  return (
    <div className={styles.confidenceBadge} style={{ borderColor: color }}>
      <span className={styles.confidenceCount}>{count}</span>
      <span className={styles.confidenceLabel}>{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    padding: ${theme.spacing(3)};
    max-width: 1200px;
  `,
  heading: css`
    margin-bottom: ${theme.spacing(3)};
    font-size: ${theme.typography.h2.fontSize};
  `,
  subHeading: css`
    margin-bottom: ${theme.spacing(2)};
    font-size: ${theme.typography.h4.fontSize};
  `,
  statsGrid: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: ${theme.spacing(2)};
    margin-bottom: ${theme.spacing(4)};
  `,
  statCard: css`
    background: ${theme.colors.background.secondary};
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(2)};
    text-align: center;
  `,
  statCardHighlight: css`
    background: ${theme.colors.background.secondary};
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(2)};
    text-align: center;
    border: 1px solid ${theme.colors.warning.border};
  `,
  statValue: css`
    font-size: ${theme.typography.h2.fontSize};
    font-weight: ${theme.typography.fontWeightBold};
  `,
  statLabel: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    margin-top: ${theme.spacing(0.5)};
  `,
  section: css`
    margin-bottom: ${theme.spacing(4)};
  `,
  confidenceRow: css`
    display: flex;
    gap: ${theme.spacing(2)};
    flex-wrap: wrap;
  `,
  confidenceBadge: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: ${theme.spacing(1.5)};
    border: 2px solid;
    border-radius: ${theme.shape.radius.default};
    min-width: 80px;
  `,
  confidenceCount: css`
    font-size: ${theme.typography.h3.fontSize};
    font-weight: ${theme.typography.fontWeightBold};
  `,
  confidenceLabel: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
  `,
  table: css`
    width: 100%;
    border-collapse: collapse;
    th, td {
      text-align: left;
      padding: ${theme.spacing(1)};
      border-bottom: 1px solid ${theme.colors.border.weak};
    }
    th {
      font-weight: ${theme.typography.fontWeightBold};
      color: ${theme.colors.text.secondary};
    }
  `,
  actions: css`
    margin-top: ${theme.spacing(2)};
  `,
  linkButton: css`
    background: none;
    border: none;
    color: ${theme.colors.text.link};
    cursor: pointer;
    padding: 0;
    font-size: ${theme.typography.body.fontSize};
    &:hover {
      text-decoration: underline;
    }
  `,
});
