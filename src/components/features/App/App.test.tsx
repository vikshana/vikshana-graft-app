import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { AppRootProps, PluginType } from '@grafana/data';
import { render, waitFor } from '@testing-library/react';

// Mock the lazy-loaded components to avoid import issues with @grafana/llm
jest.mock('../ChatInterface/ChatInterface', () => ({
  ChatInterface: () => <div data-testid="mock-chat">Graft AI Assistant</div>,
}));
jest.mock('../../../pages/ChatHistory', () => ({
  ChatHistory: () => <div data-testid="mock-history">Chat History</div>,
}));
jest.mock('../../../pages/PromptLibrary', () => ({
  PromptLibrary: () => <div data-testid="mock-prompts">Prompt Library</div>,
}));

// Mock ChatInterface hooks
jest.mock('../ChatInterface/hooks', () => ({
  useRollingPlaceholder: () => 'Ask me anything...',
  usePluginSettings: () => ({ llmConfigured: true, llmHealthy: true, standardAvailable: true, thinkingAvailable: true, isLoading: false, error: null }),
  useAutoScroll: () => ({ scrollRef: { current: null }, autoScrollToBottom: jest.fn() }),
}));

// Mock ESM modules
jest.mock('react-markdown', () => {
  const MockMarkdown = (props: any) => <div data-testid="markdown">{props.children}</div>;
  MockMarkdown.displayName = 'MockMarkdown';
  return MockMarkdown;
});
jest.mock('remark-gfm', () => () => { });
jest.mock('react-syntax-highlighter', () => ({
  Prism: (props: any) => <div data-testid="syntax-highlighter">{props.children}</div>,
}));
jest.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({
  vscDarkPlus: {},
  vs: {},
}));
jest.mock('mermaid', () => ({
  default: {
    initialize: jest.fn(),
    render: jest.fn().mockResolvedValue({ svg: '<svg></svg>' }),
  },
}));

// Mock @grafana/llm
jest.mock('@grafana/llm', () => ({
  llm: {
    health: jest.fn().mockResolvedValue({
      configured: true,
      ok: true,
      models: { base: { ok: true }, large: { ok: true } }
    }),
    enabled: jest.fn().mockResolvedValue(true),
    chatCompletions: jest.fn(),
    Model: { BASE: 'base', LARGE: 'large' }
  },
  mcp: {
    useMCPClient: jest.fn().mockReturnValue({ enabled: false, client: null }),
    convertToolsToOpenAI: jest.fn().mockReturnValue([])
  }
}));

// Mock services
jest.mock('../../../services/llm', () => ({
  llmService: {
    chat: jest.fn(),
  },
}));
jest.mock('../../../services/context', () => ({
  contextService: {
    getCurrentDashboard: jest.fn(),
  },
}));
jest.mock('../../../services/chatHistory', () => ({
  chatHistoryService: {
    getSession: jest.fn(),
    saveSession: jest.fn(),
  },
}));

import App from './App';

describe('Components/App', () => {
  let props: AppRootProps;

  beforeEach(() => {
    jest.resetAllMocks();

    props = {
      basename: 'a/sample-app',
      meta: {
        id: 'sample-app',
        name: 'Sample App',
        type: PluginType.app,
        enabled: true,
        jsonData: {},
      },
      query: {},
      path: '',
      onNavChanged: jest.fn(),
    } as unknown as AppRootProps;
  });

  test('renders without an error"', async () => {
    const { queryByText } = render(
      <MemoryRouter>
        <App {...props} />
      </MemoryRouter>
    );

    // Application is lazy loaded, so we need to wait for the component and routes to be rendered
    await waitFor(() => expect(queryByText(/Graft AI Assistant/i)).toBeInTheDocument(), { timeout: 2000 });
  });
});
