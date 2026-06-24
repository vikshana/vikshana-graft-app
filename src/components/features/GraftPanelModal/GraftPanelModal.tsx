import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { mcp } from '@grafana/llm';
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
 * App React tree, so it cannot rely on:
 *   - BrowserRouter (no URL — uses MemoryRouter instead)
 *   - The app-level MCPClientProvider (provides its own)
 *   - Any React context from the main App
 *
 * The modal renders a full ChatInterface pre-loaded with the panel context
 * that was captured at the moment the user clicked the panel menu item.
 */
export function GraftPanelModal({ panelContext, onDismiss }: GraftPanelModalProps) {
  return (
    <MemoryRouter>
      <mcp.MCPClientProvider appName="vikshana-graft-app" appVersion="0.1.0">
        <ChatInterface panelContext={panelContext} onDismiss={onDismiss} />
      </mcp.MCPClientProvider>
    </MemoryRouter>
  );
}
