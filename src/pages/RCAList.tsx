import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { css } from '@emotion/css';
import { useStyles2, LoadingPlaceholder, Alert, Input, Select } from '@grafana/ui';
import { GrafanaTheme2, SelectableValue } from '@grafana/data';

import { listRCAs } from '../services/rcaApi';
import { RCASummary } from '../types/rca.types';
import { prefixRoute } from '../utils/utils.routing';
import { ROUTES } from '../constants';

const STATUS_OPTIONS: Array<SelectableValue<string>> = [
  { label: 'All statuses', value: '' },
  { label: 'Triggered', value: 'triggered' },
  { label: 'Investigating', value: 'investigating' },
  { label: 'Complete', value: 'complete' },
  { label: 'Failed', value: 'failed' },
];

const PAGE_SIZE = 20;

export function RCAList() {
  const styles = useStyles2(getStyles);
  const navigate = useNavigate();

  const [items, setItems] = useState<RCASummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [alertName, setAlertName] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [serviceFilter, setServiceFilter] = useState('');

  const fetchRCAs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listRCAs({
        alert_name: alertName || undefined,
        status: statusFilter || undefined,
        service_name: serviceFilter || undefined,
        page,
        page_size: PAGE_SIZE,
      });
      setItems(result.items);
      setTotal(result.total);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [alertName, statusFilter, serviceFilter, page]);

  useEffect(() => {
    fetchRCAs();
  }, [fetchRCAs]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className={styles.container}>
      <h1 className={styles.heading}>RCA History</h1>

      {/* Filter bar */}
      <div className={styles.filterBar}>
        <Input
          placeholder="Search by alert name..."
          value={alertName}
          onChange={(e) => {
            setAlertName(e.currentTarget.value);
            setPage(1);
          }}
          width={30}
        />
        <Select
          options={STATUS_OPTIONS}
          value={statusFilter}
          onChange={(v: SelectableValue<string>) => {
            setStatusFilter(v.value ?? '');
            setPage(1);
          }}
          width={20}
          placeholder="Filter by status"
        />
        <Input
          placeholder="Filter by service..."
          value={serviceFilter}
          onChange={(e) => {
            setServiceFilter(e.currentTarget.value);
            setPage(1);
          }}
          width={20}
        />
      </div>

      {error && <Alert title="Failed to load RCAs" severity="error">{error}</Alert>}

      {loading ? (
        <LoadingPlaceholder text="Loading RCA runs..." />
      ) : (
        <>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Alert Name</th>
                <th>Service</th>
                <th>Status</th>
                <th>Confidence</th>
                <th>Duration</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td colSpan={7} className={styles.emptyCell}>No RCA runs found.</td>
                </tr>
              ) : (
                items.map((rca) => (
                  <tr key={rca.id}>
                    <td>{rca.alert_name}</td>
                    <td>{rca.service_name ?? '—'}</td>
                    <td>
                      <span className={styles.statusBadge} data-status={rca.status}>
                        {rca.status}
                      </span>
                    </td>
                    <td>{rca.confidence_level ?? '—'}</td>
                    <td>
                      {rca.duration_seconds !== null ? `${rca.duration_seconds}s` : '—'}
                    </td>
                    <td>{new Date(rca.created_at).toLocaleString()}</td>
                    <td>
                      <button
                        className={styles.investigateLink}
                        onClick={() =>
                          navigate(prefixRoute(`${ROUTES.RcaInvestigate}/${rca.id}`))
                        }
                      >
                        Investigate →
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className={styles.pagination}>
              <button
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                className={styles.pageButton}
              >
                ← Prev
              </button>
              <span className={styles.pageInfo}>
                Page {page} of {totalPages} ({total} total)
              </span>
              <button
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
                className={styles.pageButton}
              >
                Next →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    padding: ${theme.spacing(3)};
    max-width: 1400px;
  `,
  heading: css`
    margin-bottom: ${theme.spacing(3)};
    font-size: ${theme.typography.h2.fontSize};
  `,
  filterBar: css`
    display: flex;
    gap: ${theme.spacing(2)};
    margin-bottom: ${theme.spacing(3)};
    flex-wrap: wrap;
    align-items: center;
  `,
  table: css`
    width: 100%;
    border-collapse: collapse;
    th, td {
      text-align: left;
      padding: ${theme.spacing(1.5)};
      border-bottom: 1px solid ${theme.colors.border.weak};
    }
    th {
      font-weight: ${theme.typography.fontWeightBold};
      color: ${theme.colors.text.secondary};
      background: ${theme.colors.background.secondary};
    }
    tr:hover td {
      background: ${theme.colors.action.hover};
    }
  `,
  emptyCell: css`
    text-align: center;
    padding: ${theme.spacing(4)};
    color: ${theme.colors.text.secondary};
  `,
  statusBadge: css`
    padding: ${theme.spacing(0.25)} ${theme.spacing(1)};
    border-radius: ${theme.shape.radius.pill};
    font-size: ${theme.typography.bodySmall.fontSize};
    background: ${theme.colors.background.secondary};

    &[data-status='complete'] { background: ${theme.colors.success.transparent}; }
    &[data-status='failed'] { background: ${theme.colors.error.transparent}; }
    &[data-status='investigating'] { background: ${theme.colors.warning.transparent}; }
  `,
  investigateLink: css`
    background: none;
    border: none;
    color: ${theme.colors.text.link};
    cursor: pointer;
    padding: 0;
    font-size: ${theme.typography.bodySmall.fontSize};
    &:hover { text-decoration: underline; }
  `,
  pagination: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(2)};
    margin-top: ${theme.spacing(3)};
    justify-content: center;
  `,
  pageButton: css`
    padding: ${theme.spacing(0.5)} ${theme.spacing(2)};
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.medium};
    border-radius: ${theme.shape.radius.default};
    cursor: pointer;
    &:disabled { opacity: 0.4; cursor: not-allowed; }
    &:hover:not(:disabled) { background: ${theme.colors.action.hover}; }
  `,
  pageInfo: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
});
