'use client';

import { useSidebar } from '@/components/Sidebar';

/**
 * Client wrapper for main content area — adjusts left margin
 * based on sidebar collapsed state.
 */
export function LayoutContent({ children }: { children: React.ReactNode }) {
  const { collapsed } = useSidebar();

  return (
    <main
      className="pt-14 min-h-[calc(100vh-3.5rem)] transition-[margin-left] duration-200 ease-in-out"
      style={{ marginLeft: collapsed ? '60px' : '220px' }}
    >
      <div className="max-w-[1280px] mx-auto px-8 py-8 page-enter">
        {children}
      </div>
    </main>
  );
}

