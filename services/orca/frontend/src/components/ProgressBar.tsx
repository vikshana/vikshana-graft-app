import clsx from 'clsx';

interface ProgressBarProps {
  label: string;
  percentage: number;
  color?: 'blue' | 'green' | 'yellow' | 'red';
}

const COLOR_MAP: Record<string, { bar: string; glow: string }> = {
  blue:   { bar: 'var(--accent)',       glow: 'var(--glow-color)' },
  green:  { bar: 'var(--success)',      glow: 'var(--glow-success)' },
  yellow: { bar: 'var(--primary)',      glow: 'var(--glow-color)' },
  red:    { bar: 'var(--destructive)',  glow: 'var(--glow-destructive)' },
};

/**
 * Labelled horizontal progress bar with coloured glow on the fill.
 */
export function ProgressBar({ label, percentage, color = 'blue' }: ProgressBarProps) {
  const { bar, glow } = COLOR_MAP[color] ?? COLOR_MAP.blue;
  const pct = Math.min(percentage, 100);

  return (
    <div className="flex items-center gap-3">
      <span
        className="text-xs font-medium shrink-0 w-36 truncate"
        style={{ color: 'var(--foreground)' }}
      >
        {label}
      </span>
      <div
        className="flex-1 h-[6px] rounded-full overflow-hidden"
        style={{ background: 'var(--border)' }}
      >
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{
            width: `${pct}%`,
            background: bar,
            boxShadow: pct > 0 ? `0 0 6px ${glow}` : 'none',
          }}
        />
      </div>
      <span
        className="text-xs font-semibold w-10 text-right shrink-0"
        style={{ color: 'var(--foreground)', fontFamily: 'var(--font-mono, monospace)' }}
      >
        {pct}%
      </span>
    </div>
  );
}
