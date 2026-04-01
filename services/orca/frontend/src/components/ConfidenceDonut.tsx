interface ConfidenceDonutProps {
  percentage: number;
  size?: number;
}

/**
 * Glowing SVG donut chart for overall confidence percentage.
 * Uses the primary cyan accent with a soft glow filter.
 */
export function ConfidenceDonut({ percentage, size = 140 }: ConfidenceDonutProps) {
  const strokeWidth = 9;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (percentage / 100) * circumference;

  return (
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <defs>
          <filter id="donut-glow">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        {/* Track */}
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          stroke="var(--border)"
          strokeWidth={strokeWidth}
          fill="none"
          strokeOpacity={0.6}
        />
        {/* Progress arc */}
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          stroke="var(--primary)"
          strokeWidth={strokeWidth}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          filter="url(#donut-glow)"
          className="transition-all duration-700 ease-out"
        />
      </svg>
      <div className="absolute flex flex-col items-center">
        <span
          className="text-[26px] font-display font-bold leading-none"
          style={{ color: 'var(--foreground)' }}
        >
          {percentage}%
        </span>
      </div>
    </div>
  );
}
