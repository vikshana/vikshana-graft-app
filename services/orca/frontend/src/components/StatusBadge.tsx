import type { RCAStatus, ConfidenceLevel } from '@/types/rca';
import clsx from 'clsx';

interface StatusBadgeProps {
  status: RCAStatus;
  className?: string;
}

interface StatusCfg {
  label: string;
  color: string;
  bg: string;
  border: string;
  glow: string;
  pulse: boolean;
}

const STATUS_CONFIG: Record<RCAStatus, StatusCfg> = {
  triggered: {
    label: 'Triggered',
    color: 'var(--warning)',
    bg: 'rgba(240,180,32,0.08)',
    border: 'rgba(240,180,32,0.25)',
    glow: 'var(--glow-warning)',
    pulse: false,
  },
  investigating: {
    label: 'Investigating',
    color: 'var(--primary)',
    bg: 'rgba(0,186,212,0.08)',
    border: 'rgba(0,186,212,0.25)',
    glow: 'var(--glow-color)',
    pulse: true,
  },
  complete: {
    label: 'Complete',
    color: 'var(--success)',
    bg: 'rgba(24,200,160,0.08)',
    border: 'rgba(24,200,160,0.25)',
    glow: 'var(--glow-success)',
    pulse: false,
  },
  failed: {
    label: 'Failed',
    color: 'var(--destructive)',
    bg: 'rgba(248,112,112,0.08)',
    border: 'rgba(248,112,112,0.25)',
    glow: 'var(--glow-destructive)',
    pulse: false,
  },
};

/**
 * Glowing pill status badge with coloured dot indicator.
 */
export function StatusBadge({ status, className }: StatusBadgeProps) {
  const cfg: StatusCfg = STATUS_CONFIG[status] ?? {
    label: status,
    color: 'var(--muted-foreground)',
    bg: 'transparent',
    border: 'var(--border)',
    glow: 'transparent',
    pulse: false,
  };

  return (
    <span
      className={clsx('inline-flex items-center gap-1.5 px-2.5 py-[3px] rounded-full text-[11.5px] font-medium border', className)}
      style={{
        color: cfg.color,
        background: cfg.bg,
        borderColor: cfg.border,
      }}
    >
      <span
        className={clsx('w-[5px] h-[5px] rounded-full shrink-0', cfg.pulse && 'animate-glow-breathe')}
        style={{
          background: cfg.color,
          boxShadow: `0 0 5px ${cfg.glow}`,
        }}
      />
      {cfg.label}
    </span>
  );
}

/* ── Confidence badge ─────────────────────────────────────────────────── */

interface ConfidenceBadgeProps {
  level: ConfidenceLevel | null;
  reasoning?: string | null;
  className?: string;
}

interface ConfCfg {
  label: string;
  color: string;
  bg: string;
  border: string;
  glow: string;
}

const CONFIDENCE_CONFIG: Record<ConfidenceLevel, ConfCfg> = {
  high: {
    label: 'HIGH',
    color: 'var(--success)',
    bg: 'rgba(24,200,160,0.08)',
    border: 'rgba(24,200,160,0.3)',
    glow: 'var(--glow-success)',
  },
  medium: {
    label: 'MEDIUM',
    color: 'var(--warning)',
    bg: 'rgba(240,180,32,0.08)',
    border: 'rgba(240,180,32,0.3)',
    glow: 'var(--glow-warning)',
  },
  low: {
    label: 'LOW',
    color: 'var(--destructive)',
    bg: 'rgba(248,112,112,0.08)',
    border: 'rgba(248,112,112,0.3)',
    glow: 'var(--glow-destructive)',
  },
};

/**
 * Compact monospace confidence pill — HIGH / MEDIUM / LOW.
 */
export function ConfidenceBadge({ level, reasoning, className }: ConfidenceBadgeProps) {
  if (!level) return null;
  const cfg = CONFIDENCE_CONFIG[level];

  return (
    <span
      className={clsx(
        'inline-flex items-center px-2 py-[2px] rounded text-[10px] font-semibold border tracking-[0.1em]',
        className,
      )}
      style={{
        color: cfg.color,
        background: cfg.bg,
        borderColor: cfg.border,
        boxShadow: `0 0 8px ${cfg.glow}`,
        fontFamily: 'var(--font-mono, monospace)',
      }}
      title={reasoning ?? undefined}
    >
      {cfg.label}
    </span>
  );
}
