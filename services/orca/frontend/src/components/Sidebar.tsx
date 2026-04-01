'use client';

import { createContext, useContext, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';

/* ── Collapse context ─────────────────────────────────────────────────── */

interface SidebarCtx {
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
}

const SidebarContext = createContext<SidebarCtx>({
  collapsed: false,
  setCollapsed: () => {},
});

export function useSidebar() {
  return useContext(SidebarContext);
}

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <SidebarContext.Provider value={{ collapsed, setCollapsed }}>
      {children}
    </SidebarContext.Provider>
  );
}

/* ── Nav config ───────────────────────────────────────────────────────── */

interface NavItem {
  label: string;
  href: string;
  section?: string;
  icon: React.ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  {
    label: 'Dashboard',
    href: '/',
    section: 'OVERVIEW',
    icon: (
      <svg className="w-[17px] h-[17px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <rect x="3" y="3" width="7" height="7" rx="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    label: 'RCA Runs',
    href: '/rca-runs',
    icon: (
      <svg className="w-[17px] h-[17px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18" />
      </svg>
    ),
  },
  {
    label: 'Integrations',
    href: '/integrations',
    section: 'CONFIGURE',
    icon: (
      <svg className="w-[17px] h-[17px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.86-2.132a4.5 4.5 0 00-6.364-6.364L4.5 8.25a4.5 4.5 0 006.364 6.364l4.5-4.5z" />
      </svg>
    ),
  },
];

const BOTTOM_ITEMS: NavItem[] = [
  {
    label: 'Settings',
    href: '/settings',
    icon: (
      <svg className="w-[17px] h-[17px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
];

/* ── Sidebar component ────────────────────────────────────────────────── */

export function Sidebar() {
  const pathname = usePathname();
  const { collapsed, setCollapsed } = useSidebar();

  const isActive = (href: string): boolean => {
    if (href === '/') return pathname === '/';
    return pathname.startsWith(href);
  };

  let lastSection: string | undefined;

  return (
    <aside
      className={clsx(
        'fixed left-0 top-0 bottom-0 z-30 flex flex-col',
        'border-r border-sidebar-border',
        'transition-[width] duration-200 ease-in-out overflow-hidden',
        collapsed ? 'w-[60px]' : 'w-[220px]',
      )}
      style={{
        background: 'var(--sidebar-bg)',
        backgroundImage:
          'radial-gradient(circle, rgba(0,186,212,0.04) 1px, transparent 1px)',
        backgroundSize: '22px 22px',
      }}
    >
      {/* ── Brand / logo ───────────────────────────────────────────── */}
      <div
        className={clsx(
          'h-14 flex items-center shrink-0 border-b border-sidebar-border',
          collapsed ? 'px-[14px] justify-center' : 'px-4',
        )}
      >
        {/* Sonar-ring logo */}
        <div className="relative w-8 h-8 shrink-0 flex items-center justify-center">
          {/* Two expanding rings */}
          <span className="absolute inset-0 rounded-full bg-primary/25 animate-sonar-ping pointer-events-none" />
          <span
            className="absolute inset-0 rounded-full bg-primary/15 animate-sonar-ping pointer-events-none"
            style={{ animationDelay: '1.3s' }}
          />
          {/* Logo circle */}
          <div className="relative w-8 h-8 rounded-full border border-primary/30 bg-primary/10 flex items-center justify-center">
            <span className="text-[15px] leading-none select-none">🐋</span>
          </div>
        </div>

        {!collapsed && (
          <div className="ml-2.5 flex-1 min-w-0">
            <div className="text-[13px] font-display font-bold text-foreground tracking-[0.18em] uppercase leading-tight">
              ORCA
            </div>
            <div
              className="text-[8.5px] tracking-[0.12em] uppercase leading-tight"
              style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-mono, monospace)' }}
            >
              Root Cause Analyser
            </div>
          </div>
        )}

        {/* header is logo-only; toggle lives at the bottom of nav */}
      </div>

      {/* ── Navigation ─────────────────────────────────────────────── */}
      <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-[2px]">
        {NAV_ITEMS.map((item) => {
          const showSection = !collapsed && item.section && item.section !== lastSection;
          if (item.section) lastSection = item.section;
          const active = isActive(item.href);

          return (
            <div key={item.href}>
              {showSection && (
                <p
                  className="px-3 pt-5 pb-1.5 text-[9.5px] font-semibold tracking-[0.14em] select-none"
                  style={{ color: 'var(--sidebar-muted)', fontFamily: 'var(--font-mono, monospace)' }}
                >
                  {item.section}
                </p>
              )}
              <Link
                href={item.href}
                title={collapsed ? item.label : undefined}
                className={clsx(
                  'flex items-center gap-2.5 rounded-[6px] text-sm transition-all duration-150',
                  collapsed ? 'justify-center py-2.5 px-0' : 'py-[7px] px-3',
                  active
                    ? 'bg-sidebar-active-bg text-sidebar-active font-medium nav-item-active'
                    : 'text-sidebar-foreground hover:bg-sidebar-muted/20 hover:text-foreground',
                )}
              >
                <span className={clsx('shrink-0', active ? 'text-sidebar-active' : 'text-sidebar-foreground')}>
                  {item.icon}
                </span>
                {!collapsed && item.label}
              </Link>
            </div>
          );
        })}
      </nav>

      {/* ── Bottom section ─────────────────────────────────────────── */}
      <div className="border-t border-sidebar-border px-2 py-2 space-y-[2px]">
        {/* Settings */}
        {BOTTOM_ITEMS.map((item) => {
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              title={collapsed ? item.label : undefined}
              className={clsx(
                'flex items-center gap-2.5 rounded-[6px] text-sm transition-all duration-150',
                collapsed ? 'justify-center py-2.5 px-0' : 'py-[7px] px-3',
                active
                  ? 'bg-sidebar-active-bg text-sidebar-active font-medium nav-item-active'
                  : 'text-sidebar-foreground hover:bg-sidebar-muted/20 hover:text-foreground',
              )}
            >
              <span className={clsx('shrink-0', active ? 'text-sidebar-active' : 'text-sidebar-foreground')}>
                {item.icon}
              </span>
              {!collapsed && item.label}
            </Link>
          );
        })}

        {/* User row — no divider above, flows directly after settings */}
        <div
          className={clsx(
            'flex items-center gap-2.5 rounded-[6px]',
            collapsed ? 'justify-center py-2.5 px-0' : 'py-[7px] px-3',
          )}
        >
          <div className="relative shrink-0">
            <div className="w-7 h-7 rounded-full bg-primary/15 border border-primary/25 flex items-center justify-center text-[10px] font-display font-bold text-primary">
              AV
            </div>
            <span
              className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border border-sidebar-bg animate-glow-breathe"
              style={{ background: 'var(--success)', boxShadow: '0 0 5px var(--glow-success)' }}
            />
          </div>
          {!collapsed && (
            <div className="flex-1 min-w-0">
              <p className="text-[12px] font-medium text-foreground truncate leading-tight">
                Avanish Vaghela
              </p>
              <p
                className="text-[9.5px] truncate leading-tight"
                style={{ color: 'var(--sidebar-foreground)', fontFamily: 'var(--font-mono, monospace)' }}
              >
                avanish@ingka.com
              </p>
            </div>
          )}
        </div>

        {/* Divider sits above collapse only — full width via -mx-2 */}
        <div className="-mx-2 border-t border-sidebar-border !my-2" />

        {/* Collapse / expand — hamburger ↔ close */}
        <button
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={clsx(
            'w-full flex items-center gap-2.5 rounded-[6px] text-sm transition-all duration-150',
            'text-sidebar-foreground hover:bg-sidebar-muted/20 hover:text-foreground',
            collapsed ? 'justify-center py-2.5 px-0' : 'py-[7px] px-3',
          )}
        >
          {collapsed ? (
            /* Hamburger when collapsed — click to expand */
            <svg className="w-[17px] h-[17px] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
            </svg>
          ) : (
            /* X when expanded — click to collapse */
            <svg className="w-[17px] h-[17px] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          )}
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </aside>
  );
}
