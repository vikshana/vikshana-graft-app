import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStyles2, Alert, Input, Select, LoadingPlaceholder, Pagination } from '@grafana/ui';import { SelectableValue } from '@grafana/data';

import { listRCAs } from '../services/rcaApi';
import { RCASummary } from '../types/rca.types';
import { prefixRoute } from '../utils/utils.routing';
import { ROUTES } from '../constants';
import { testIds } from '../components/testIds';
import { PageHeader } from '../components/common/PageHeader';
import { getStyles } from './RCAList.styles';

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
    <div className={styles.container} data-testid={testIds.rcaList.container}>
      <PageHeader
        title="RCA History"
        backTo={prefixRoute(ROUTES.Rca)}
        data-testid={testIds.rcaList.backButton}
      />

      <div className={styles.content}>
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
            data-testid={testIds.rcaList.alertNameFilter}
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
            data-testid={testIds.rcaList.statusFilter}
          />
          <Input
            placeholder="Filter by service..."
            value={serviceFilter}
            onChange={(e) => {
              setServiceFilter(e.currentTarget.value);
              setPage(1);
            }}
            width={20}
            data-testid={testIds.rcaList.serviceFilter}
          />
        </div>

        {error && (
          <div className={styles.errorWrapper}>
            <Alert title="Failed to load RCAs" severity="error">{error}</Alert>
          </div>
        )}

        {loading ? (
          <LoadingPlaceholder text="Loading RCA runs..." />
        ) : (
          <>
            <table className={styles.table} data-testid={testIds.rcaList.table}>
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
                      <td>
                        {rca.duration_seconds !== null ? `${rca.duration_seconds}s` : '—'}
                      </td>
                      <td>{new Date(rca.created_at).toLocaleString()}</td>
                      <td>
                        <button
                          className={styles.investigateBtn}
                          onClick={(e) => {
                            e.stopPropagation();
                            navigate(prefixRoute(`${ROUTES.RcaInvestigate}/${rca.id}`));
                          }}
                          data-testid={testIds.rcaList.investigateButton}
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
                <Pagination
                  currentPage={page}
                  numberOfPages={totalPages}
                  onNavigate={setPage}
                  data-testid={testIds.rcaList.pagination}
                />
                <span className={styles.pageInfo}>({total} total)</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
