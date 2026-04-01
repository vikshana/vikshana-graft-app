import type { Metadata } from 'next';
import { Syne, Figtree, Space_Mono } from 'next/font/google';
import './globals.css';
import { Sidebar, SidebarProvider } from '@/components/Sidebar';
import { TopNav } from '@/components/TopNav';
import { ThemeProvider } from '@/components/ThemeProvider';
import { LayoutContent } from '@/components/LayoutContent';
import { BreadcrumbProvider } from '@/components/BreadcrumbContext';

/* ── Google Fonts via next/font ──────────────────────────────────────── */
const figtree = Figtree({
  subsets: ['latin'],
  variable: '--font-sans',
  weight: ['300', '400', '500', '600'],
  display: 'swap',
});

const syne = Syne({
  subsets: ['latin'],
  variable: '--font-display',
  weight: ['400', '500', '600', '700', '800'],
  display: 'swap',
});

const spaceMono = Space_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  weight: ['400', '700'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Orca — Omniscient Root Cause Analyser',
  description: 'Agentic RCA system powered by LLMs, triggered by Grafana alerts.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className="dark">
      <body
        className={`${figtree.variable} ${syne.variable} ${spaceMono.variable} bg-background text-foreground min-h-screen font-sans antialiased`}
      >
        <ThemeProvider>
          <SidebarProvider>
            <BreadcrumbProvider>
              <Sidebar />
              <TopNav />
              <LayoutContent>{children}</LayoutContent>
            </BreadcrumbProvider>
          </SidebarProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
