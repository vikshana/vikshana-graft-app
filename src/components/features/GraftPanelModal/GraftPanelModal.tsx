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
 * This component is mounted by Grafana's extension system OUTSIDE the main
 * App React tree, but INSIDE Grafana's BrowserRouter. We must NOT add a
 * MemoryRouter here — React Router v6 forbids nested Router contexts.
 * ChatInterface's URL hooks will use the existing Grafana BrowserRouter.
 *
 * The panelContext prop prevents ChatInterface from reading session state
 * from URL params (the modal has no relevant URL params of its own).
 *
 * Suspense is required above MCPClientProvider because MCPClientProvider
 * uses the Suspense data-fetching pattern (resource.read() can throw a
 * Promise).
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
