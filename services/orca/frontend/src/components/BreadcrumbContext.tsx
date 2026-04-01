'use client';

import { createContext, useContext, useEffect, useState } from 'react';

interface BreadcrumbCtx {
  subtitle: string | null;
  setSubtitle: (s: string | null) => void;
}

const BreadcrumbContext = createContext<BreadcrumbCtx>({
  subtitle: null,
  setSubtitle: () => {},
});

export function useBreadcrumb() {
  return useContext(BreadcrumbContext);
}

export function BreadcrumbProvider({ children }: { children: React.ReactNode }) {
  const [subtitle, setSubtitle] = useState<string | null>(null);
  return (
    <BreadcrumbContext.Provider value={{ subtitle, setSubtitle }}>
      {children}
    </BreadcrumbContext.Provider>
  );
}

/**
 * Drop into any page to push a subtitle into the TopNav breadcrumb.
 * Cleans up on unmount automatically.
 */
export function BreadcrumbSetter({ name }: { name: string }) {
  const { setSubtitle } = useBreadcrumb();
  useEffect(() => {
    setSubtitle(name);
    return () => setSubtitle(null);
  }, [name, setSubtitle]);
  return null;
}

