import React from 'react';
import { render, screen } from '@testing-library/react';
import { GraftPanelModal } from './GraftPanelModal';
import type { PluginExtensionPanelContext } from '@grafana/data';

// Mock @grafana/llm MCP provider
jest.mock('@grafana/llm', () => ({
  mcp: {
    MCPClientProvider: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="mcp-provider">{children}</div>
    ),
    useMCPClient: jest.fn().mockReturnValue({ enabled: false, client: null }),
    convertToolsToOpenAI: jest.fn().mockReturnValue([]),
  },
  llm: {
    health: jest.fn().mockResolvedValue({
      configured: true,
      ok: true,
      models: { base: { ok: true }, large: { ok: true } },
    }),
    enabled: jest.fn().mockResolvedValue(true),
    chatCompletions: jest.fn(),
    Model: { BASE: 'base', LARGE: 'large' },
  },
}));

// Mock heavy ChatInterface dependencies
jest.mock('../ChatInterface/ChatInterface', () => ({
  ChatInterface: ({ panelContext, onDismiss }: any) => (
    <div data-testid="chat-interface">
      {panelContext && (
        <span data-testid="panel-context-title">{panelContext.title}</span>
      )}
      {onDismiss && (
        <button data-testid="dismiss-button" onClick={onDismiss}>
          Dismiss
        </button>
      )}
    </div>
  ),
}));

const mockPanelContext: PluginExtensionPanelContext = {
  pluginId: 'timeseries',
  id: 42,
  title: 'CPU Usage',
  timeRange: { from: 'now-1h', to: 'now' },
  timeZone: 'browser',
  dashboard: { uid: 'dash-uid-1', title: 'My Dashboard', tags: [] },
  targets: [
    {
      refId: 'A',
      datasource: { uid: 'prom-uid', type: 'prometheus' },
    },
  ],
};

describe('GraftPanelModal', () => {
  it('renders MCPClientProvider wrapper', () => {
    render(<GraftPanelModal panelContext={mockPanelContext} />);
    expect(screen.getByTestId('mcp-provider')).toBeInTheDocument();
  });

  it('renders ChatInterface with panelContext prop', () => {
    render(<GraftPanelModal panelContext={mockPanelContext} />);
    expect(screen.getByTestId('panel-context-title')).toHaveTextContent('CPU Usage');
  });

  it('passes onDismiss to ChatInterface', () => {
    const onDismiss = jest.fn();
    render(<GraftPanelModal panelContext={mockPanelContext} onDismiss={onDismiss} />);
    const btn = screen.getByTestId('dismiss-button');
    btn.click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('renders without panelContext (graceful fallback)', () => {
    render(<GraftPanelModal panelContext={undefined} />);
    expect(screen.getByTestId('chat-interface')).toBeInTheDocument();
  });
});
