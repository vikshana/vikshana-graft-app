'use client';

import { usePathname } from 'next/navigation';
import { useSidebar } from '@/components/Sidebar';
import { useTheme } from '@/components/ThemeProvider';
import { useBreadcrumb } from '@/components/BreadcrumbContext';

const PAGE_TITLES: Record<string, string> = {
  '/':             'DASHBOARD',
  '/rca-runs':   'RCA RUNS',
  '/integrations': 'INTEGRATIONS',
  '/settings':     'SETTINGS',
};

/**
 * Top bar with terminal-style breadcrumb, live status indicator,
 * and theme toggle. Tracks sidebar collapse state for left offset.
 */
export function TopNav() {
  const pathname = usePathname();
  const { collapsed } = useSidebar();
  const { theme, toggleTheme } = useTheme();
  const { subtitle } = useBreadcrumb();

  const title =
    PAGE_TITLES[pathname] ??
    (pathname.startsWith('/rca/') ? 'RCA RUNS' : 'ORCA');

  return (
    <header
      className="fixed top-0 right-0 h-14 z-20 flex items-center justify-between px-6 transition-[left] duration-200 ease-in-out"
      style={{
        left: collapsed ? '60px' : '220px',
        background: 'var(--background)',
        borderBottom: '1px solid var(--border)',
      }}
    >
      {/* ── Breadcrumb ─────────────────────────────────────────────── */}
      <div
        className="flex items-center gap-1.5 text-[11px] tracking-[0.08em] select-none min-w-0"
        style={{ fontFamily: 'var(--font-mono, monospace)' }}
      >
        <span style={{ color: 'var(--muted-foreground)' }}>ORCA</span>
        <span style={{ color: 'var(--border)' }}>/</span>
        <span
          className={subtitle ? 'text-muted-foreground' : 'font-semibold'}
          style={{ color: subtitle ? 'var(--muted-foreground)' : 'var(--foreground)' }}
        >
          {title}
        </span>
        {subtitle && (
          <>
            <span style={{ color: 'var(--border)' }}>/</span>
            <span
              className="font-semibold truncate max-w-[260px]"
              style={{ color: 'var(--foreground)' }}
            >
              {subtitle}
            </span>
          </>
        )}
      </div>

      {/* ── Right controls ─────────────────────────────────────────── */}
      <div className="flex items-center gap-4">
        {/* Live indicator */}
        <div className="flex items-center gap-2">
          <span
            className="w-[7px] h-[7px] rounded-full animate-glow-breathe"
            style={{
              background: 'var(--success)',
              boxShadow: '0 0 6px var(--glow-success)',
            }}
          />
          <span
            className="text-[10px] font-semibold tracking-[0.14em] hidden sm:block"
            style={{ color: 'var(--success)', fontFamily: 'var(--font-mono, monospace)' }}
          >
            LIVE
          </span>
        </div>

        {/* Divider */}
        <div className="w-px h-5 bg-border" />

        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          className="w-8 h-8 flex items-center justify-center rounded-[6px] transition-colors"
          style={{ color: 'var(--muted-foreground)' }}
          onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--foreground)')}
          onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--muted-foreground)')}
          aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
          title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
        >
          {theme === 'light' ? (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.718 9.718 0 0112.478 3.003a9.72 9.72 0 109.274 11.999z" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1.5M12 19.5V21M4.219 4.219l1.061 1.061M17.72 17.72l1.06 1.06M3 12h1.5M19.5 12H21M4.219 19.781l1.061-1.061M17.72 6.28l1.06-1.06" />
              <circle cx="12" cy="12" r="4" />
            </svg>
          )}
        </button>
      </div>
    </header>
  );
}
