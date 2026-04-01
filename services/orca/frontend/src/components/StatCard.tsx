interface StatCardProps {
  label: string;
  value: string;
  subtitle?: string;
  icon?: React.ReactNode;
  variant?: 'default' | 'health';
  trend?: 'up' | 'down' | 'neutral';
  trendValue?: string;
}

/**
 * Dashboard metric card — glass surface with top accent line,
 * Syne display font for the value, monospace label.
 */
export function StatCard({ label, value, subtitle, trend, trendValue }: StatCardProps) {
  const trendColor =
    trend === 'up'
      ? 'var(--success)'
      : trend === 'down'
      ? 'var(--destructive)'
      : 'var(--muted-foreground)';

  const trendGlow =
    trend === 'up'
      ? 'var(--glow-success)'
      : trend === 'down'
      ? 'var(--glow-destructive)'
      : 'transparent';

  const TrendIcon = () =>
    trend === 'neutral' || !trend ? null : (
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        {trend === 'down' ? (
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 6L9 12.75l4.286-4.286a11.948 11.948 0 014.306 6.43l.776 2.898" />
        ) : (
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22" />
        )}
      </svg>
    );

  return (
    <div
      className="relative bg-card rounded-xl border border-border overflow-hidden flex flex-col justify-between min-h-[148px] p-5 card-interactive"
      style={{ transition: 'box-shadow 0.2s ease, border-color 0.2s ease' }}
    >
      {/* Top accent gradient line */}
      <div
        className="absolute top-0 left-0 right-0 h-px"
        style={{
          background: 'linear-gradient(90deg, transparent 0%, var(--primary) 40%, var(--primary) 60%, transparent 100%)',
          opacity: 0.5,
        }}
      />

      {/* Label row */}
      <div className="flex items-start justify-between gap-2">
        <span
          className="text-[10.5px] font-semibold tracking-[0.12em] uppercase"
          style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-mono, monospace)' }}
        >
          {label}
        </span>
        {trendValue && (
          <span
            className="flex items-center gap-1 text-[11px] font-semibold shrink-0"
            style={{ color: trendColor, filter: `drop-shadow(0 0 4px ${trendGlow})` }}
          >
            <TrendIcon />
            {trendValue}
          </span>
        )}
      </div>

      {/* Value */}
      <div className="mt-auto pt-3">
        <p
          className="text-[32px] font-display font-bold leading-none tracking-tight"
          style={{ color: 'var(--foreground)' }}
        >
          {value}
        </p>
        {subtitle && (
          <p
            className="text-[11px] mt-1.5"
            style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-mono, monospace)' }}
          >
            {subtitle}
          </p>
        )}
      </div>
    </div>
  );
}
