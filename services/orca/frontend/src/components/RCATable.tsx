import Link from 'next/link';
import type { RCASummary, RCAFilters } from '@/types/rca';
import { StatusBadge, ConfidenceBadge } from './StatusBadge';

interface RCATableProps {
  items: RCASummary[];
  total: number;
  page: number;
  pageSize: number;
  filters: RCAFilters;
  onPageChange: (page: number) => void;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleString('en-GB', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const PaginationButton = ({
  onClick,
  disabled,
  label,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  label: string;
  children: React.ReactNode;
}) => (
  <button
    onClick={onClick}
    disabled={disabled}
    aria-label={label}
    className="w-8 h-8 flex items-center justify-center rounded-[6px] border border-border text-sm text-muted-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors hover:border-primary/40 hover:text-primary"
    style={{ background: 'var(--card)' }}
  >
    {children}
  </button>
);

/**
 * Dark data table for RCA summaries.
 */
export function RCATable({ items, total, page, pageSize, onPageChange }: RCATableProps) {
  const totalPages = Math.ceil(total / pageSize);
  const startItem = (page - 1) * pageSize + 1;
  const endItem = Math.min(page * pageSize, total);

  if (items.length === 0) {
    return (
      <div
        className="rounded-xl border border-border p-16 text-center"
        style={{ background: 'var(--card)' }}
      >
        <div className="text-3xl mb-3 opacity-40">🐋</div>
        <p className="text-sm font-medium" style={{ color: 'var(--foreground)' }}>
          No agent runs found
        </p>
        <p className="text-xs mt-1" style={{ color: 'var(--muted-foreground)' }}>
          {total === 0
            ? 'No root cause analyses have been generated yet.'
            : 'No results match the current filters.'}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border overflow-hidden" style={{ background: 'var(--card)' }}>
      <div className="overflow-x-auto">
        <table className="min-w-full">
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              {['Alert Name', 'Confidence', 'Team', 'Service', 'Started', 'Status', ''].map((h) => (
                <th
                  key={h}
                  className="px-5 py-3 text-left text-[10px] font-semibold tracking-[0.1em] uppercase"
                  style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-mono, monospace)' }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((rca, i) => (
              <tr
                key={rca.id}
                className="group transition-colors"
                style={{
                  borderBottom: i < items.length - 1 ? '1px solid var(--border)' : undefined,
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLTableRowElement).style.background = 'rgba(0,186,212,0.03)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLTableRowElement).style.background = '';
                }}
              >
                {/* Alert name + ID */}
                <td className="px-5 py-3.5">
                  <Link
                    href={`/rca/${rca.id}`}
                    className="text-sm font-medium transition-colors block"
                    style={{ color: 'var(--foreground)' }}
                    onMouseEnter={(e) => ((e.target as HTMLElement).style.color = 'var(--primary)')}
                    onMouseLeave={(e) => ((e.target as HTMLElement).style.color = 'var(--foreground)')}
                  >
                    {rca.alert_name}
                  </Link>
                  <p
                    className="text-[10px] mt-0.5"
                    style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-mono, monospace)' }}
                  >
                    {rca.id.slice(0, 8)}
                  </p>
                  {rca.duplicate_count > 0 && (
                    <span
                      title={`${rca.duplicate_count} duplicate alert${rca.duplicate_count === 1 ? '' : 's'} suppressed`}
                      className="inline-flex items-center px-1.5 py-[1px] rounded text-[9.5px] font-semibold mt-1"
                      style={{
                        color: 'var(--warning)',
                        background: 'rgba(240,180,32,0.08)',
                        border: '1px solid rgba(240,180,32,0.2)',
                        fontFamily: 'var(--font-mono, monospace)',
                      }}
                    >
                      ×{rca.duplicate_count} dupes
                    </span>
                  )}
                </td>

                {/* Confidence */}
                <td className="px-5 py-3.5">
                  {rca.confidence_level ? (
                    <ConfidenceBadge level={rca.confidence_level} />
                  ) : (
                    <span className="text-muted-foreground text-sm">—</span>
                  )}
                </td>

                {/* Team */}
                <td className="px-5 py-3.5 text-sm" style={{ color: 'var(--secondary-foreground)' }}>
                  {rca.team ?? '—'}
                </td>

                {/* Service */}
                <td className="px-5 py-3.5 text-sm" style={{ color: 'var(--secondary-foreground)' }}>
                  {rca.service_name ?? '—'}
                </td>

                {/* Started */}
                <td
                  className="px-5 py-3.5 text-[11px] whitespace-nowrap"
                  style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-mono, monospace)' }}
                >
                  {formatDate(rca.created_at)}
                </td>

                {/* Status */}
                <td className="px-5 py-3.5">
                  <StatusBadge status={rca.status} />
                </td>

                {/* Action */}
                <td className="px-5 py-3.5">
                  <Link
                    href={`/rca/${rca.id}`}
                    className="text-[11px] font-semibold transition-colors"
                    style={{ color: 'var(--accent)', fontFamily: 'var(--font-mono, monospace)' }}
                    onMouseEnter={(e) => ((e.target as HTMLElement).style.opacity = '0.7')}
                    onMouseLeave={(e) => ((e.target as HTMLElement).style.opacity = '1')}
                  >
                    VIEW →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination footer */}
      <div
        className="flex items-center justify-between px-5 py-3"
        style={{ borderTop: '1px solid var(--border)' }}
      >
        <span
          className="text-[11px]"
          style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-mono, monospace)' }}
        >
          {startItem}–{endItem} / {total}
        </span>
        <div className="flex items-center gap-1">
          <PaginationButton onClick={() => onPageChange(1)} disabled={page <= 1} label="First page">«</PaginationButton>
          <PaginationButton onClick={() => onPageChange(page - 1)} disabled={page <= 1} label="Previous page">‹</PaginationButton>
          <span
            className="px-3 text-[11px] font-semibold"
            style={{ color: 'var(--foreground)', fontFamily: 'var(--font-mono, monospace)' }}
          >
            {page} / {totalPages}
          </span>
          <PaginationButton onClick={() => onPageChange(page + 1)} disabled={page >= totalPages} label="Next page">›</PaginationButton>
          <PaginationButton onClick={() => onPageChange(totalPages)} disabled={page >= totalPages} label="Last page">»</PaginationButton>
        </div>
      </div>
    </div>
  );
}
