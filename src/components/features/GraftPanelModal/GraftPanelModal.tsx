import React, { Suspense } from 'react';
import { mcp } from '@grafana/llm';
import { LoadingPlaceholder } from '@grafana/ui';
import type { PluginExtensionPanelContext } from '@grafana/data';
import { ChatInterface } from '../ChatInterface/ChatInterface';

export interface GraftPanelModalProps {
  panelContext: Readonly<PluginExtensionPanelContext> | undefined;
  onDismiss?: () => void;
}

/**
 * Self-contained modal wrapper for the Graft chat interface.
 *
 * Renders inside Grafana's existing BrowserRouter (no MemoryRouter needed).
 * The panelContext prop prevents ChatInterface from restoring URL session
 * state and pre-fills the input with panel context instead.
 *
 * The "Open in Graft" button is injected into Grafana's own modal title bar
 * via a JSX title element in module.tsx — so it never scrolls away.
 */
export function GraftPanelModal({ panelContext, onDismiss }: GraftPanelModalProps) {
  return (
    <Suspense fallback={<LoadingPlaceholder text="Loading Graft..." />}>
      <mcp.MCPClientProvider appName="vikshana-graft-app" appVersion="0.1.0">
        <ChatInterface panelContext={panelContext} onDismiss={onDismiss} />
      </mcp.MCPClientProvider>
    </Suspense>
  );
}
