import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStyles2, LoadingBar, Alert, Badge, Button, Stack } from '@grafana/ui';
import { css } from '@emotion/css';

import { listSessions } from '../services/sessionApi';
import { prefixRoute } from '../utils/utils.routing';
import { ROUTES } from '../constants';
import { PageHeader } from '../components/common/PageHeader';
import type { SessionListItem } from '../types/session.types';

const STATUS_COLORS: Record<string, 'blue' | 'green' | 'red' | 'orange' | 'gray'> = {
  active: 'blue',
  completed: 'green',
  failed: 'red',
  paused: 'orange',
  awaiting_approval: 'orange',
};

function statusBadge(status: string) {
  const color = STATUS_COLORS[status] ?? 'gray';
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
      <PageHeader title="Sessions" />
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
        <>
          <div className={styles.count}>{total} session{total !== 1 ? 's' : ''}</div>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>ID</th>
                <th>Type</th>
                <th>Status</th>
                <th>Alert</th>
                <th>Service</th>
                <th>Auth</th>
                <th>Created</th>
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
                  <td className={styles.idCell}>{s.id.slice(0, 8)}…</td>
                  <td>{s.type}</td>
                  <td>{statusBadge(s.status)}</td>
                  <td>{s.alert_type ?? '—'}</td>
                  <td>{s.service ?? '—'}</td>
                  <td>
                    {s.auth_mode === 'service_account' ? (
                      <span title="Running with team credentials" style={{ fontSize: 11, color: '#9fa7b3' }}>
                        team creds
                      </span>
                    ) : (
                      <span style={{ fontSize: 11 }}>{s.auth_mode}</span>
                    )}
                  </td>
                  <td style={{ fontSize: 11, color: '#9fa7b3' }}>
                    {s.created_at ? new Date(s.created_at).toLocaleString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

const getStyles = () => ({
  container: css`
    padding: 16px;
  `,
  count: css`
    font-size: 12px;
    color: #9fa7b3;
    margin-bottom: 8px;
  `,
  table: css`
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
    th {
      text-align: left;
      padding: 6px 8px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.07);
      color: #9fa7b3;
      font-weight: 500;
    }
  `,
  row: css`
    cursor: pointer;
    td {
      padding: 8px 8px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    }
    &:hover td {
      background: rgba(255, 255, 255, 0.03);
    }
  `,
  idCell: css`
    font-family: monospace;
    font-size: 11px;
  `,
  empty: css`
    text-align: center;
    padding: 40px 0;
    color: #9fa7b3;
  `,
});
