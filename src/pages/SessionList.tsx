import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStyles2, LoadingBar, Alert, Badge, Button } from '@grafana/ui';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import type { BadgeColor } from '@grafana/ui';

import { listSessions } from '../services/sessionApi';
import { prefixRoute } from '../utils/utils.routing';
import { ROUTES } from '../constants';
import type { SessionListItem } from '../types/session.types';

const STATUS_COLORS: Record<string, BadgeColor> = {
  active: 'blue',
  completed: 'green',
  failed: 'red',
  paused: 'orange',
  awaiting_approval: 'orange',
};

function statusBadge(status: string) {
  const color: BadgeColor = STATUS_COLORS[status] ?? 'darkgrey';
  return <Badge text={status} color={color} />;
}

/**
 * SessionList — shows all harness sessions for the current organisation.
 *
 * Clicking a row navigates to /sessions/:id (SessionPanel).
 * Lives alongside the existing /rca pages (Option A).
 */
export function SessionList() {
  const styles = useStyles2(getStyles);
  const navigate = useNavigate();

  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listSessions({ limit: 50 })
      .then((resp) => {
        if (!cancelled) {
          setSessions(resp.sessions);
          setTotal(resp.total);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(String(e));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>Sessions</h1>
      </div>
      {loading && <LoadingBar width={400} />}
      {error && (
        <Alert severity="error" title="Failed to load sessions">
          {error}
        </Alert>
      )}
      {!loading && !error && sessions.length === 0 && (
        <div data-testid="sessions-empty" className={styles.empty}>
          <p>No sessions yet.</p>
          <p>Start an investigation from the RCA page to create your first session.</p>
          <Button
            variant="secondary"
            onClick={() => navigate(prefixRoute(ROUTES.Rca))}
          >
            Go to RCA
          </Button>
        </div>
      )}
      {sessions.length > 0 && (
        <div className={styles.content}>
          <div className={styles.count}>{total} session{total !== 1 ? 's' : ''}</div>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.th}>ID</th>
                <th className={styles.th}>Type</th>
                <th className={styles.th}>Status</th>
                <th className={styles.th}>Alert</th>
                <th className={styles.th}>Service</th>
                <th className={styles.th}>Auth</th>
                <th className={styles.th}>Created</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr
                  key={s.id}
                  data-testid={`session-row-${s.id}`}
                  className={styles.row}
                  onClick={() => navigate(prefixRoute(`${ROUTES.Sessions}/${s.id}`))}
                >
                  <td className={`${styles.td} ${styles.idCell}`}>{s.id.slice(0, 8)}…</td>
                  <td className={styles.td}>{s.type}</td>
                  <td className={styles.td}>{statusBadge(s.status)}</td>
                  <td className={styles.td}>{s.alert_type ?? '—'}</td>
                  <td className={styles.td}>{s.service ?? '—'}</td>
                  <td className={styles.td}>
                    <span className={styles.meta}>
                      {s.auth_mode === 'service_account' ? 'team creds' : s.auth_mode}
                    </span>
                  </td>
                  <td className={styles.td}>
                    <span className={styles.meta}>
                      {s.created_at ? new Date(s.created_at).toLocaleString() : '—'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    display: flex;
    flex-direction: column;
    height: 100%;
  `,
  header: css`
    display: flex;
    align-items: center;
    padding: ${theme.spacing(2)};
    border-bottom: 1px solid ${theme.colors.border.weak};
    background: ${theme.colors.background.primary};
    position: sticky;
    top: 40px;
    z-index: 10;
  `,
  title: css`
    font-size: ${theme.typography.h4.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.primary};
    margin: 0;
  `,
  content: css`
    padding: ${theme.spacing(2)};
  `,
  count: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    margin-bottom: ${theme.spacing(1)};
  `,
  table: css`
    width: 100%;
    border-collapse: collapse;
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  th: css`
    text-align: left;
    padding: ${theme.spacing(0.75, 1)};
    border-bottom: 1px solid ${theme.colors.border.weak};
    color: ${theme.colors.text.secondary};
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  td: css`
    padding: ${theme.spacing(1)};
    border-bottom: 1px solid ${theme.colors.border.weak};
    color: ${theme.colors.text.primary};
  `,
  row: css`
    cursor: pointer;
    &:hover td {
      background: ${theme.colors.action.hover};
    }
  `,
  idCell: css`
    font-family: ${theme.typography.fontFamilyMonospace};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  meta: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
  `,
  empty: css`
    text-align: center;
    padding: ${theme.spacing(6)} 0;
    color: ${theme.colors.text.secondary};
  `,
});
