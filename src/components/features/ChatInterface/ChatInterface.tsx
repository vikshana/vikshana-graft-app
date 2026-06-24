import React, { useState, useEffect, useRef } from 'react';
import { CodeBlock } from './components/CodeBlock';
import { MermaidBlock } from './components/MermaidBlock';
import { ThinkingBlock } from './components/ThinkingBlock';
import { PlanBlock } from './components/PlanBlock';
import { ToolCallContainer } from './components/ToolCallContainer';
import { StepToolCallContainer } from './components/StepToolCallContainer';
import { FilePreview } from './components/FilePreview';
import { AttachmentModal } from './components/AttachmentModal';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { useSearchParams, useNavigate, useLocation } from 'react-router-dom';

// Grafana packages
import { Alert, Button, TextArea, useStyles2, useTheme2, Icon, ConfirmModal } from '@grafana/ui';
import { GrafanaTheme2, type PluginExtensionPanelContext } from '@grafana/data';
import { mcp } from '@grafana/llm';

// Constants
import { PLUGIN_BASE_URL } from '../../../constants';

// Local services
import { llmService } from '../../../services/llm';
import type { Message, ToolExecution, StepToolExecutions } from '../../../types/llm.types';
import { contextService, UserContext, DataSourceContext, DashboardContext, DashboardSchemaCapability } from '../../../services/context';
import { chatHistoryService } from '../../../services/chatHistory';
import { truncateMessages } from '../../../services/truncation';
import { filterTools } from '../../../services/toolFilter';
import { runOrchestration } from '../../../services/agents/orchestrator';
import type { OrchestrationUpdate } from '../../../services/agents/types';
import type { ToolsConfig } from '../../../types/settings.types';

/**
 * Merges an incoming toolExecutions update for a specific stepId into the
 * existing stepGroups array, replacing only that step's entry and leaving
 * all other steps intact. This prevents parallel specialists from clobbering
 * each other's tool call state.
 */
function mergeStepToolExecutions(
  existing: StepToolExecutions[],
  stepId: string,
  stepDescription: string,
  toolExecutions: ToolExecution[],
  status: StepToolExecutions['status'],
  error?: string
): StepToolExecutions[] {
  const idx = existing.findIndex(s => s.stepId === stepId);
  const entry: StepToolExecutions = { stepId, stepDescription, toolExecutions, status, error };
  if (idx === -1) {
    return [...existing, entry];
  }
  const updated = [...existing];
  updated[idx] = entry;
  return updated;
}

// Local hooks
import { useRollingPlaceholder, usePluginSettings, useAutoScroll } from './hooks';

// Styles
import { getStyles } from './ChatInterface.styles';


// Helper function to get time-based greeting
const getTimeBasedGreeting = (): string => {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) {
    return 'Good Morning';
  } else if (hour >= 12 && hour < 17) {
    return 'Good Afternoon';
  } else {
    return 'Good Evening';
  }
};

// Helper function to get greeting message with optional user name
const getGreetingMessage = (userName?: string): string => {
  const timeGreeting = getTimeBasedGreeting();
  return userName ? `${timeGreeting}, ${userName}!` : timeGreeting;
};

// Custom hook for rolling placeholder text with typing animation
// Hook definitions have been moved to ./ChatInterface/hooks/

// Helper function to normalize markdown content
const normalizeMarkdown = (content: string): string => {
  // Replace multiple consecutive newlines with a single newline
  return content.replace(/\n\n+/g, '\n');
};

const formatContext = (
  dashboard: DashboardContext,
  user: UserContext,
  dataSources: DataSourceContext[],
  toolsConfig?: ToolsConfig,
  grafanaVersion?: string,
  dashboardSchema?: DashboardSchemaCapability,
  panelOverride?: Readonly<PluginExtensionPanelContext>,
): string => {
  const lines: string[] = [];

  // Role + scope (critical instructions near top)
  lines.push(
    `You are Graft, an AI assistant embedded in Grafana. ` +
    `You help users query metrics and logs, build and edit dashboards, and understand their observability data. ` +
    `If a request is unrelated to Grafana, metrics, logs, or dashboards, politely decline.`
  );
  lines.push('');

  // Behavioural instructions (positive framing, near top for primacy)
  lines.push(
    `When using tools: call the next tool immediately when you have enough information — ` +
    `do not narrate your next step in text. Only respond with text when the task is fully ` +
    `complete or you need clarification from the user. ` +
    `If a tool returns an error or empty result, explain what failed and why before stopping.`
  );
  lines.push('');

  // Output format
  lines.push(
    `Output format: use markdown. Wrap PromQL in \`\`\`promql blocks, LogQL in \`\`\`logql blocks, ` +
    `and dashboard JSON in \`\`\`json blocks. Keep explanations concise.`
  );
  lines.push('');

  // Dynamic runtime context
  lines.push(`Current time: ${new Date().toISOString()}`);

  if (grafanaVersion) {
    lines.push(`Grafana version: ${grafanaVersion}`);
  }
  if (dashboardSchema) {
    lines.push(`Dashboard schema capability: ${dashboardSchema}`);
  }

  if (user?.login) {
    lines.push(`User: ${user.name || user.login} | Role: ${user.orgRole}`);
  }

  if (dashboard.uid) {
    lines.push(`Active dashboard: "${dashboard.title}" (uid: ${dashboard.uid})`);
  }

  // Datasource-to-tool mapping — inform the model about tool availability per datasource
  if (dataSources?.length > 0) {
    lines.push('');
    lines.push('Available datasources:');
    dataSources.forEach(ds => {
      let toolHint = '';
      if (ds.type === 'prometheus') {
        const enabled = !toolsConfig || toolsConfig.prometheus?.enabled !== false;
        toolHint = enabled
          ? ' → query_prometheus, list_prometheus_*'
          : ' (Prometheus tools are disabled — enable them in the Graft plugin settings at /plugins/vikshana-graft-app)';
      } else if (ds.type === 'loki') {
        const enabled = !toolsConfig || toolsConfig.loki?.enabled !== false;
        toolHint = enabled
          ? ' → query_loki_logs, list_loki_*'
          : ' (Loki tools are disabled — enable them in the Graft plugin settings at /plugins/vikshana-graft-app)';
      } else {
        toolHint = ' (no query tools available for this datasource type)';
      }
      lines.push(`- ${ds.name} (${ds.type}, uid: ${ds.uid})${toolHint}`);
    });
  }

  // Query guidance
  lines.push('');
  lines.push('Query guidance:');
  lines.push('- Prometheus: PromQL. Call list_prometheus_metric_names before querying unknown metrics.');
  lines.push('- Loki: LogQL. Call list_loki_label_names/values to discover labels before querying.');
  lines.push('- Time ranges: use Grafana relative format ("now-1h" / "now"). Default to last 1 hour unless the user specifies otherwise.');

  // Dashboard editing — aligned with v1 quality rules (see dashboardAgent.ts buildV1DashboardRules)
  lines.push('');
  lines.push('Dashboard editing:');
  lines.push(
    `- To modify an existing dashboard: call get_dashboard_by_uid first, then call update_dashboard with the modified JSON.`
  );
  lines.push(
    `- To create a new dashboard: follow the skeleton → get-UID → add-all-panels-in-one-call process. ` +
    `First call update_dashboard with a minimal skeleton (title, uid: "", id: null, empty panels array, schemaVersion: 38). ` +
    `Then call get_dashboard_by_uid to get the assigned UID. ` +
    `Then build ALL panels at once and call update_dashboard a single time with the complete panels array.`
  );
  lines.push(
    `- Panel quality: set fieldConfig.defaults.unit for every data panel (e.g. "s", "bytes", "reqps", "percent"). ` +
    `Set thresholds on stat/gauge panels (null→green, warning→orange, critical→red). ` +
    `Set a description on every panel. Group related panels into rows using type:"row" panels.`
  );
  lines.push(
    `- Template variables: where labels are known, add query variables to templating.list ` +
    `(e.g. label_values(up, job)) with includeAll:true. Use \${var:regex} in matchers.`
  );
  lines.push(
    `- Only confirm the dashboard UID with the user if they reference an existing dashboard by name and you cannot determine its UID from context.`
  );
  lines.push(
    `- Dashboard links: when referencing a created or modified dashboard, always render its UID as a markdown link: [Open dashboard](/d/{uid}). Never leave a UID as bare text.`
  );

  // Panel context — injected when the user launched Graft from a specific panel
  if (panelOverride) {
    lines.push('');
    lines.push('Panel context (user launched Graft directly from this panel):');
    lines.push(`- Panel: "${panelOverride.title}" (id: ${panelOverride.id}, type: ${panelOverride.pluginId})`);
    lines.push(`- Dashboard: "${panelOverride.dashboard.title}" (uid: ${panelOverride.dashboard.uid})`);
    lines.push(`- Time range: ${panelOverride.timeRange.from} to ${panelOverride.timeRange.to} (tz: ${panelOverride.timeZone})`);
    if (panelOverride.targets?.length) {
      lines.push(`- Panel queries: ${JSON.stringify(panelOverride.targets)}`);
    }
  }

  return lines.join('\n');
};





const MemoizedReactMarkdown = React.memo(({ content, theme, onRender, isStreaming }: { content: string; theme: GrafanaTheme2; onRender: () => void; isStreaming: boolean }) => {
  const components = React.useMemo(() => ({
    a({ href, children, ...props }: any) {
      // Open all links in a new tab with safe rel attributes
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
          {children}
        </a>
      );
    },
    code({ node, inline, className, children, ...props }: any) {
      const match = /language-(\w+)/.exec(className || '');
      const language = match ? match[1] : '';

      // Handle mermaid diagrams-only render after streaming completes
      if (!inline && language === 'mermaid') {
        return (
          <MermaidBlock theme={theme} onRender={onRender} isStreaming={isStreaming}>
            {String(children).replace(/\n$/, '')}
          </MermaidBlock>
        );
      }

      // Handle other code blocks
      return !inline && match ? (
        <CodeBlock language={language} theme={theme}>
          {String(children).replace(/\n$/, '')}
        </CodeBlock>
      ) : (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }
  }), [theme, isStreaming, onRender]);

  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {normalizeMarkdown(content)}
    </ReactMarkdown>
  );
});

MemoizedReactMarkdown.displayName = 'MemoizedReactMarkdown';




export interface ChatInterfaceProps {
  /** Panel context snapshot passed when launched from a Grafana panel menu. */
  panelContext?: Readonly<PluginExtensionPanelContext>;
  /** Called when the modal wrapper should be closed (only set in modal mode). */
  onDismiss?: () => void;
}

export const ChatInterface = ({ panelContext, onDismiss }: ChatInterfaceProps = {}) => {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const [isListening, setIsListening] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | undefined>();
  const [copiedMessageIndex, setCopiedMessageIndex] = useState<number | null>(null);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [messageToDelete, setMessageToDelete] = useState<number | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const processedPromptRef = useRef<string | null>(null);
  const thinkingStartTimeRef = useRef<number | null>(null);
  // Tracks the latest messages array without creating a render dependency.
  // Used by the post-chat save callback to read state without a setMessages updater.
  const latestMessagesRef = useRef<Message[]>(messages);
  const [selectedFiles, setSelectedFiles] = useState<Array<{ name: string; content: string; type: 'image' | 'text'; mimeType?: string }>>([]);
  const [modelType, setModelType] = useState<'standard' | 'thinking'>('standard');
  const [previewAttachment, setPreviewAttachment] = useState<{ name: string; content: string; type: 'image' | 'text'; mimeType?: string } | null>(null);

  // Use custom hooks - check LLM plugin health and model availability
  const { llmConfigured, llmHealthy, standardAvailable, thinkingAvailable, toolsConfig, maxToolIterations, isLoading: settingsLoading } = usePluginSettings();
  const llmReady = llmConfigured && llmHealthy;
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const {
    messagesEndRef,
    messageListRef,
    scrollToBottom,
    handleScroll,
    scrollDownPage,
  } = useAutoScroll({ shouldAutoScroll, setShouldAutoScroll, showScrollButton, setShowScrollButton });

  // MCP Client
  const { client: mcpClient, enabled: mcpEnabled } = mcp.useMCPClient();
  const [mcpTools, setMcpTools] = useState<any[]>([]);

  useEffect(() => {
    if (mcpEnabled && mcpClient) {
      mcpClient.listTools().then((response) => {
        const tools = filterTools(mcp.convertToolsToOpenAI(response.tools), toolsConfig);
        setMcpTools(tools);
      }).catch(() => {
        // MCP tools loading failed - continue without tools
      });
    }
  }, [mcpEnabled, mcpClient, toolsConfig]);

  // Use rolling placeholder hook for animated text
  const rollingPlaceholder = useRollingPlaceholder();

  // Get user context for personalized greeting
  const userContext = contextService.getUserContext();
  const userName = userContext.name || userContext.login;
  const greetingMessage = getGreetingMessage(userName);

  // Auto-select the only available model when settings load
  // Keep latestMessagesRef in sync on every render so the post-chat save
  // callback can read the final messages state without a setMessages updater.
  useEffect(() => {
    latestMessagesRef.current = messages;
  });

  useEffect(() => {
    if (!settingsLoading && llmReady) {
      // If only one model is available, auto-select it
      if (!standardAvailable && thinkingAvailable) {
        setModelType('thinking');
      } else if (standardAvailable && !thinkingAvailable) {
        setModelType('standard');
      }
    }
  }, [settingsLoading, llmReady, standardAvailable, thinkingAvailable]);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) {
      return;
    }

    const newFiles: Array<{ name: string; content: string; type: 'image' | 'text'; mimeType?: string }> = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.type.startsWith('image/')) {
        // Allow images - the LLM plugin will return an error if the model doesn't support them
        const mimeType = file.type;
        const reader = new FileReader();
        await new Promise<void>((resolve) => {
          reader.onloadend = () => {
            newFiles.push({ name: file.name, content: reader.result as string, type: 'image', mimeType });
            resolve();
          };
          reader.readAsDataURL(file);
        });
      } else if (file.type.startsWith('text/') || file.name.endsWith('.txt') || file.name.endsWith('.md') || file.name.endsWith('.json') || file.name.endsWith('.ts') || file.name.endsWith('.js')) {
        const reader = new FileReader();
        await new Promise<void>((resolve) => {
          reader.onloadend = () => {
            newFiles.push({ name: file.name, content: reader.result as string, type: 'text' });
            resolve();
          };
          reader.readAsText(file);
        });
      } else {
        alert(`File ${file.name} is not supported. Only Text or Image files are supported.`);
      }
    }

    setSelectedFiles((prev) => [...prev, ...newFiles]);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const removeFile = (index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const clearFiles = () => {
    setSelectedFiles([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // Sync state with URL and load session if specified
  useEffect(() => {
    if (panelContext) { return; } // modal mode — no URL session to restore
    const sessionId = searchParams.get('session');
    const isChatActive = searchParams.get('chat');

    if (sessionId) {
      const session = chatHistoryService.getSession(sessionId);
      if (session && session.id !== currentSessionId) {
        setMessages(session.messages);
        setCurrentSessionId(session.id);
      }
    } else if (!isChatActive && !isLoading) {
      // If we are navigating to landing page, abort any ongoing request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
        setIsLoading(false);
      }
      // Only reset if we have messages to clear
      if (messages.length > 0 || currentSessionId !== undefined) {
        setMessages([]);
        setCurrentSessionId(undefined);
      }
    }
  }, [searchParams, currentSessionId, messages.length, isLoading]);

  // Handle pre-filled prompt from navigation state (separate effect to avoid loop)
  useEffect(() => {
    const state = location.state as { prompt?: string; returnTo?: string } | null;
    if (state?.prompt && state.prompt !== processedPromptRef.current) {
      processedPromptRef.current = state.prompt;
      setInput(state.prompt);
      // Clear the state so it doesn't persist on refresh/navigation
      navigate(location.pathname, { replace: true, state: { ...state, prompt: undefined } });
    }
  }, [location.state, location.pathname, navigate]);

  // Pre-fill input from panel context when launched from a panel menu modal (mount-only)
  useEffect(() => {
    if (!panelContext) { return; }
    const dsUid = panelContext.targets?.[0]?.datasource?.uid;
    const dsHint = dsUid ? ` (datasource uid: ${dsUid})` : '';
    setInput(
      `Tell me about the "${panelContext.title}" panel on the ` +
      `"${panelContext.dashboard.title}" dashboard${dsHint}. ` +
      `Time range: ${panelContext.timeRange.from} to ${panelContext.timeRange.to}.`
    );
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Pre-fill input from Explore toolbar URL params (mount-only, full-page mode only)
  useEffect(() => {
    if (panelContext) { return; }
    const dsUid      = searchParams.get('dsUid');
    const dsType     = searchParams.get('dsType');
    const from       = searchParams.get('from');
    const to         = searchParams.get('to');
    const rawQueries = searchParams.get('queries');
    if (!dsUid && !rawQueries) { return; }

    const parts: string[] = ['I want to analyze some data from Grafana Explore.'];
    if (dsUid) { parts.push(`Datasource UID: ${dsUid}${dsType ? ` (${dsType})` : ''}.`); }
    if (from && to) { parts.push(`Time range: ${from} to ${to}.`); }
    if (rawQueries) {
      try {
        const qs: Array<{ expr?: string; refId: string }> = JSON.parse(rawQueries);
        const exprs = qs.map((q) => q.expr).filter(Boolean);
        if (exprs.length) { parts.push(`Queries: ${exprs.join('; ')}.`); }
      } catch { /* ignore malformed JSON */ }
    }
    setInput(parts.join(' '));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Pre-fill input from panel context URL params — used when "Open in Graft" is clicked
  // with no prior messages (zero-message path from GraftPanelModal)
  useEffect(() => {
    if (panelContext) { return; }
    const panelTitle     = searchParams.get('panelTitle');
    const dashboardTitle = searchParams.get('dashboardTitle');
    const from           = searchParams.get('from');
    const to             = searchParams.get('to');
    const dsUid          = searchParams.get('dsUid');
    if (!panelTitle) { return; }

    const dsHint = dsUid ? ` (datasource uid: ${dsUid})` : '';
    const timeHint = from && to ? ` Time range: ${from} to ${to}.` : '';
    setInput(
      `Tell me about the "${panelTitle}" panel` +
      `${dashboardTitle ? ` on the "${dashboardTitle}" dashboard` : ''}${dsHint}.${timeHint}`
    );
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Handler for "Open in Graft" button inside the panel modal.
  // If messages exist: flush the session to localStorage and open with ?session=<id>.
  // If no messages yet: re-encode panel context in URL so full-page Graft pre-fills.
  const handleOpenInGraft = () => {
    if (!panelContext) { return; }
    if (messages.length > 0) {
      const saved = chatHistoryService.saveSession(messages, currentSessionId);
      window.open(`${PLUGIN_BASE_URL}/?chat=true&session=${saved.id}`, '_blank');
    } else {
      const params = new URLSearchParams({
        panelTitle:     panelContext.title,
        dashboardUid:   panelContext.dashboard.uid,
        dashboardTitle: panelContext.dashboard.title,
        panelId:        String(panelContext.id),
        panelPlugin:    panelContext.pluginId,
        from:           panelContext.timeRange.from,
        to:             panelContext.timeRange.to,
        tz:             panelContext.timeZone,
      });
      const dsUid = panelContext.targets?.[0]?.datasource?.uid;
      if (dsUid) { params.set('dsUid', dsUid); }
      window.open(`${PLUGIN_BASE_URL}/?${params.toString()}`, '_blank');
    }
  };

  // Initial scroll to bottom when chat loads
  useEffect(() => {
    if (messages.length > 0 && !isLoading) {
      // Scroll to bottom when opening a history session
      // Use 'auto' for instant scroll to ensure it reaches the bottom
      setTimeout(() => scrollToBottom('auto'), 200);
    }
  }, [currentSessionId, messages.length, isLoading, scrollToBottom]);

  // Auto-scroll during streaming or when new messages appear
  useEffect(() => {
    if (messages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      // Scroll if it's a user message (new question)
      if (lastMsg.role === 'user') {
        scrollToBottom();
        setShouldAutoScroll(true);
      }
      // Only auto-scroll during streaming if user is near bottom or has auto-scroll enabled
      else if (lastMsg.role === 'assistant' && isLoading && shouldAutoScroll) {
        scrollToBottom();
      }
    }
  }, [messages, isLoading, scrollToBottom, shouldAutoScroll]);



  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsLoading(false);

    // Mark the last message as interrupted
    setMessages((prev) => {
      const updated = [...prev];
      if (updated.length > 0) {
        const lastMsg = updated[updated.length - 1];
        if (lastMsg.role === 'assistant') {
          updated[updated.length - 1] = { ...lastMsg, interrupted: true };
        }
      }
      return updated;
    });
  };

  const handleDeleteMessage = (index: number) => {
    setMessageToDelete(index);
    setDeleteModalOpen(true);
  };

  const confirmDelete = () => {
    if (messageToDelete !== null) {
      setMessages(prev => {
        const newMessages = prev.filter((_, i) => i !== messageToDelete);

        // Update session if exists
        if (currentSessionId) {
          chatHistoryService.saveSession(newMessages, currentSessionId);
        }

        return newMessages;
      });
    }

    setDeleteModalOpen(false);
    setMessageToDelete(null);
  };

  const cancelDelete = () => {
    setDeleteModalOpen(false);
    setMessageToDelete(null);
  };

  const handleSend = async () => {
    if (!input.trim()) {
      return;
    }

    // Set URL param to indicate active chat
    setSearchParams({ chat: 'true' });

    let content = input;
    const attachments: Array<{ name: string; content: string; type: 'image' | 'text'; mimeType?: string }> = [];

    if (selectedFiles.length > 0) {
      for (const file of selectedFiles) {
        if (file.type === 'image') {
          // Use mimeType from file, or extract from data URL as fallback
          const mimeType = file.mimeType || file.content.match(/^data:([^;]+);base64,/)?.[1] || 'image/jpeg';
          const base64 = file.content.split(',')[1];
          attachments.push({ name: file.name, content: base64, type: 'image', mimeType });
        } else {
          attachments.push({ name: file.name, content: file.content, type: 'text' });
        }
      }
    }

    const userMessage: Message = { role: 'user', content, attachments: attachments.length > 0 ? attachments : undefined };
    const newMessages = [...messages, userMessage];

    setMessages(newMessages);
    setInput('');
    clearFiles();
    setIsLoading(true);

    try {
      const dashboard = await contextService.getCurrentDashboard();
      const user = contextService.getUserContext();
      const dataSources = contextService.getDataSources();
      const { version: grafanaVersion, dashboardSchema } = contextService.getBuildInfo();

      const context = formatContext(dashboard, user, dataSources, toolsConfig, grafanaVersion, dashboardSchema, panelContext);

      // Create a placeholder message for the assistant
      const assistantMessage: Message = { role: 'assistant', content: '' };
      setMessages((prev) => [...prev, assistantMessage]);

      const controller = new AbortController();
      abortControllerRef.current = controller;

      // Reset thinking timer
      thinkingStartTimeRef.current = null;
      let thinkingDuration: number | undefined = undefined;

      // Track final content for saving to history
      let finalContent = '';
      let finalToolExecutions: ToolExecution[] = [];

      const truncatedMessages = truncateMessages(newMessages, 10);

      // Shared callback for updating the assistant message in the UI
      const updateAssistantMessage = (fullContent: string, toolExecutions?: ToolExecution[]) => {
        finalContent = fullContent;
        finalToolExecutions = toolExecutions || [];
        const trimmedContent = fullContent.trimStart();
        if (trimmedContent.startsWith('<think>') && thinkingStartTimeRef.current === null) {
          thinkingStartTimeRef.current = Date.now();
        }
        if (fullContent.includes('</think>') && thinkingStartTimeRef.current !== null && thinkingDuration === undefined) {
          thinkingDuration = Math.floor((Date.now() - thinkingStartTimeRef.current) / 1000);
        }
        setMessages((prev) => {
          const updated = [...prev];
          const lastMessage = updated[updated.length - 1];
          updated[updated.length - 1] = {
            ...lastMessage,
            content: fullContent,
            thinkingSeconds: thinkingDuration,
            toolExecutions: toolExecutions,
          };
          return updated;
        });
      };

      // Route through the multi-agent orchestrator when MCP tools are available;
      // fall back to the single-agent loop otherwise.
      if (mcpClient && mcpTools.length > 0) {
        await runOrchestration(
          truncatedMessages,
          context,
          mcpTools,
          mcpClient,
          modelType,
          maxToolIterations,
          controller.signal,
          toolsConfig,
          (update: OrchestrationUpdate) => {
            if (update.type === 'plan' && update.plan) {
              // Store plan on the message — rendered as a collapsible PlanBlock,
              // never written into content so it doesn't pollute the final answer.
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  ...updated[updated.length - 1],
                  agentPlan: {
                    reasoning: update.plan!.reasoning,
                    steps: update.plan!.steps,
                  },
                  agentPlanComplete: false,
                };
                return updated;
              });
            } else if (update.type === 'step_start') {
              // Planning is done — flip PlanBlock label to "View plan" and register
              // an empty group for this step so it appears immediately in the UI.
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                updated[updated.length - 1] = {
                  ...last,
                  agentPlanComplete: true,
                  stepToolExecutions: mergeStepToolExecutions(
                    last.stepToolExecutions ?? [],
                    update.stepId!,
                    update.stepDescription!,
                    [],
                    'running'
                  ),
                };
                return updated;
              });
            } else if (update.type === 'step_update' && update.stepId && update.toolExecutions) {
              // Replace only this step's tool executions — all other steps are preserved.
              // Also stream incremental content if the simple-path passes it (content is
              // the partial assistant text emitted by llmService.chat before final).
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                const existing = last.stepToolExecutions ?? [];
                const stepDesc = existing.find(s => s.stepId === update.stepId)?.stepDescription ?? update.stepId!;
                updated[updated.length - 1] = {
                  ...last,
                  ...(update.content !== undefined ? { content: update.content } : {}),
                  stepToolExecutions: mergeStepToolExecutions(
                    existing,
                    update.stepId!,
                    stepDesc,
                    update.toolExecutions!,
                    'running'
                  ),
                };
                return updated;
              });
            } else if (update.type === 'step_done' && update.stepId) {
              // Mark step as done with its final tool executions snapshot.
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                const existing = last.stepToolExecutions ?? [];
                const stepDesc = existing.find(s => s.stepId === update.stepId)?.stepDescription ?? update.stepId!;
                const hasError = (update.toolExecutions ?? []).some(t => t.status === 'error') || !!update.error;
                updated[updated.length - 1] = {
                  ...last,
                  stepToolExecutions: mergeStepToolExecutions(
                    existing,
                    update.stepId!,
                    stepDesc,
                    update.toolExecutions ?? [],
                    hasError ? 'error' : 'done',
                    update.error
                  ),
                };
                return updated;
              });
            } else if (update.type === 'final' && update.content !== undefined) {
              updateAssistantMessage(update.content, finalToolExecutions);
            }
          }
        );
      } else {
        await llmService.chat(
          truncatedMessages,
          context,
          updateAssistantMessage,
          modelType,
          controller.signal,
          mcpClient,
          mcpTools,
          maxToolIterations
        );
      }

      // Save chat to history after completion.
      // Read latestMessagesRef (not setMessages) to get the final state without
      // running side-effects inside a state updater (which React may invoke more
      // than once under StrictMode / concurrent rendering).
      const lastMsg = latestMessagesRef.current[latestMessagesRef.current.length - 1];
      const finalAssistantMessage: Message = {
        ...lastMsg,
        content: finalContent,
        thinkingSeconds: thinkingDuration,
        toolExecutions: finalToolExecutions.length > 0 ? finalToolExecutions : lastMsg?.toolExecutions,
      };
      const finalMessages = [...newMessages, finalAssistantMessage];
      const savedSession = chatHistoryService.saveSession(finalMessages, currentSessionId);
      setCurrentSessionId(savedSession.id);
      setSearchParams({ chat: 'true', session: savedSession.id });
    } catch (error: any) {
      if (error.name === 'AbortError') {
        return;
      }
      const errorMessage = `Sorry, I encountered an error: ${error.message || 'Unknown error'} `;

      // Create the error assistant message
      const errorAssistantMessage: Message = {
        role: 'assistant',
        content: errorMessage
      };

      // Replace the placeholder assistant message with the error
      // We know we added a placeholder, so always replace the last assistant message
      setMessages((prev) => {
        const updatedMessages = [...prev];
        const lastMsg = updatedMessages.length > 0 ? updatedMessages[updatedMessages.length - 1] : null;

        // Replace the last assistant message (our placeholder) with the error
        if (lastMsg && lastMsg.role === 'assistant') {
          updatedMessages[updatedMessages.length - 1] = { ...lastMsg, content: errorMessage };
          return updatedMessages;
        }

        // Fallback: append if somehow no assistant placeholder exists
        return [...prev, errorAssistantMessage];
      });

      // Save the conversation with the error message
      const finalMessages = [...newMessages, errorAssistantMessage];
      const savedSession = chatHistoryService.saveSession(finalMessages, currentSessionId);
      setCurrentSessionId(savedSession.id);
      setSearchParams({ chat: 'true', session: savedSession.id });
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleReset = () => {
    // Abort any ongoing request to prevent state updates after navigation
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsLoading(false);

    // Check if we should return to history
    const state = location.state as { returnTo?: string } | null;
    if (state?.returnTo === 'history') {
      navigate('history');
      return;
    }

    setMessages([]);
    setSearchParams({});
    setInput('');
    clearFiles();
    setCurrentSessionId(undefined);
  };

  const handleReviewPrompt = async () => {
    if (!input.trim()) {
      return;
    }

    setSearchParams({ chat: 'true' });

    const systemMessage: Message = {
      role: 'user',
      content: `Please review and improve the following prompt.Provide:
1. A critique of what could be improved
2. A rewritten, better version of the prompt
3. Explanation of the improvements

Original prompt:
${input} `
    };
    const newMessages = [systemMessage];

    setMessages(newMessages);
    setIsLoading(true);

    try {
      // Fix: use formatContext (same as handleSend) to produce a properly formatted string.
      // Previously passed raw DashboardContext object which serialised as [object Object].
      const dashboard = await contextService.getCurrentDashboard();
      const user = contextService.getUserContext();
      const dataSources = contextService.getDataSources();
      const { version: grafanaVersion, dashboardSchema } = contextService.getBuildInfo();
      const context = formatContext(dashboard, user, dataSources, toolsConfig, grafanaVersion, dashboardSchema, panelContext);
      const assistantMessage: Message = { role: 'assistant', content: '' };
      setMessages((prev) => [...prev, assistantMessage]);

      const controller = new AbortController();
      abortControllerRef.current = controller;

      // Reset thinking timer
      thinkingStartTimeRef.current = null;
      let thinkingDuration: number | undefined = undefined;

      // Track final content for saving to history
      let finalContent = '';

      await llmService.chat(newMessages, context, (fullContent) => {
        // Capture the latest content for saving after completion
        finalContent = fullContent;

        // Track thinking block timing
        if (fullContent.startsWith('<think>') && thinkingStartTimeRef.current === null) {
          // First time we see <think> tag, record the start time
          thinkingStartTimeRef.current = Date.now();
        }

        if (fullContent.includes('</think>') && thinkingStartTimeRef.current !== null && thinkingDuration === undefined) {
          // We've received the closing tag, calculate the duration
          thinkingDuration = Math.floor((Date.now() - thinkingStartTimeRef.current) / 1000);
        }

        setMessages((prev) => {
          const updated = [...prev];
          const lastMessage = updated[updated.length - 1];
          updated[updated.length - 1] = {
            ...lastMessage,
            content: fullContent,
            thinkingSeconds: thinkingDuration
          };
          return updated;
        });
      }, modelType, controller.signal);

      // Save chat to history after completion
      const finalAssistantMessage: Message = {
        role: 'assistant',
        content: finalContent,
        thinkingSeconds: thinkingDuration
      };
      const finalMessages = [...newMessages, finalAssistantMessage];
      const savedSession = chatHistoryService.saveSession(finalMessages, currentSessionId);
      setCurrentSessionId(savedSession.id);
      setSearchParams({ chat: 'true', session: savedSession.id });
    } catch (error: any) {
      if (error.name === 'AbortError') {
        return;
      }
      const errorMessage = 'Sorry, I encountered an error communicating with the backend.';

      // Create the error assistant message
      const errorAssistantMessage: Message = {
        role: 'assistant',
        content: errorMessage
      };

      // Replace the placeholder assistant message with the error
      // We know we added a placeholder, so always replace the last assistant message
      setMessages((prev) => {
        const updatedMessages = [...prev];
        const lastMsg = updatedMessages.length > 0 ? updatedMessages[updatedMessages.length - 1] : null;

        // Replace the last assistant message (our placeholder) with the error
        if (lastMsg && lastMsg.role === 'assistant') {
          updatedMessages[updatedMessages.length - 1] = { ...lastMsg, content: errorMessage };
          return updatedMessages;
        }

        // Fallback: append if somehow no assistant placeholder exists
        return [...prev, errorAssistantMessage];
      });

      // Save the conversation with the error message
      const finalMessages = [...newMessages, errorAssistantMessage];
      const savedSession = chatHistoryService.saveSession(finalMessages, currentSessionId);
      setCurrentSessionId(savedSession.id);
      setSearchParams({ chat: 'true', session: savedSession.id });

      console.error('Chat error:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDictation = () => {
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
      const SpeechRecognition = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = false;

      recognition.onstart = () => {
        setIsListening(true);
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognition.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        setInput((prev) => prev + (prev ? ' ' : '') + transcript);
      };

      recognition.start();
    } else {
      alert('Speech recognition is not supported in this browser.');
    }
  };

  return (
    <div className={styles.container}>
      {/* Sticky modal header — panel name left, Open in Graft right. Only in modal mode. */}
      {panelContext && (
        <div className={styles.modalHeader} data-testid="modal-header">
          <span className={styles.modalHeaderTitle} data-testid="modal-header-title">
            {panelContext.title}
          </span>
          <div className={styles.modalHeaderActions}>
            <Button
              variant="secondary"
              size="sm"
              icon="external-link-alt"
              onClick={handleOpenInGraft}
              data-testid="open-in-graft-button"
            >
              Open in Graft
            </Button>
          </div>
        </div>
      )}
      {messages.length === 0 ? (
        <div className={styles.landingContainer}>
          <button
            type="button"
            className={styles.settingsButton}
            data-testid="settings-button"
            title="Plugin configuration"
            aria-label="Plugin configuration"
            onClick={() => { window.location.href = '/plugins/vikshana-graft-app?page=configuration'; }}
          >
            <Icon name="cog" size="lg" />
          </button>
          <div className={styles.landingContent}>

            <div className={styles.logo}>
              <img src="public/plugins/vikshana-graft-app/img/logo.svg" alt="Graft AI Assistant" className={styles.logoImage} />
            </div>
            <h1 className={styles.title} data-testid="landing-title">{greetingMessage}</h1>

            <h2 className={styles.subtitle}>How can I help you today?</h2>


            <div className={styles.landingInputWrapper}>

              {/* LLM Plugin not configured warning banner */}
              {!settingsLoading && !llmConfigured && (
                <Alert
                  title="LLM Plugin Not Configured"
                  severity="warning"
                  style={{ marginBottom: '16px' }}
                >
                  The Grafana LLM plugin is not configured. Please{' '}
                  <a href="/plugins/grafana-llm-app" style={{ textDecoration: 'underline' }}>
                    configure the LLM plugin
                  </a>{' '}
                  to use Graft AI Assistant.
                </Alert>
              )}

              {/* LLM Plugin unhealthy warning banner */}
              {!settingsLoading && llmConfigured && !llmHealthy && (
                <Alert
                  title="LLM Plugin Unavailable"
                  severity="error"
                  style={{ marginBottom: '16px' }}
                >
                  The Grafana LLM plugin is not responding. Please check the{' '}
                  <a href="/plugins/grafana-llm-app" style={{ textDecoration: 'underline' }}>
                    LLM plugin configuration
                  </a>.
                </Alert>
              )}

              {selectedFiles.length > 0 && (
                <div className={styles.filePreviewList}>
                  {selectedFiles.map((file, index) => (
                    <FilePreview
                      key={index}
                      file={file}
                      onRemove={() => removeFile(index)}
                      onExpand={() => setPreviewAttachment(file)}
                    />
                  ))}
                </div>
              )}

              <TextArea
                data-testid="chat-input"
                value={input}
                onChange={(e) => setInput(e.currentTarget.value)}
                onKeyDown={handleKeyDown}
                placeholder={!llmReady ? 'Configure Grafana LLM plugin to start chatting...' : rollingPlaceholder}
                rows={3}
                style={{ resize: 'none', flex: 1, border: 'none', outline: 'transparent' }}
                className={styles.landingTextArea}
                disabled={!llmReady}
              />
              <div className={styles.landingInputFooter}>
                {/* Mode toggle - disabled when LLM is not ready or specific model unavailable */}
                <div className={styles.inputModeToggle}>
                  <button
                    className={`${styles.inputModeButton} ${modelType === 'standard' ? styles.inputModeButtonActive : ''} `}
                    onClick={() => setModelType('standard')}
                    disabled={!llmReady || !standardAvailable}
                    data-testid="mode-button-standard"
                    aria-pressed={modelType === 'standard'}
                    title={!llmReady ? 'LLM plugin not configured' : !standardAvailable ? 'Standard model not available' : 'Use Standard mode'}
                  >
                    ⚡️ Standard
                  </button>
                  <button
                    className={`${styles.inputModeButton} ${modelType === 'thinking' ? styles.inputModeButtonActive : ''} ${(!llmReady || !thinkingAvailable) ? styles.inputModeButtonDisabled : ''} `}
                    onClick={() => llmReady && thinkingAvailable && setModelType('thinking')}
                    disabled={!llmReady || !thinkingAvailable}
                    title={!llmReady ? 'LLM plugin not configured' : !thinkingAvailable ? 'Deep Research model not available in LLM plugin' : 'Use Deep Research mode for complex reasoning'}
                    data-testid="mode-button-deep-research"
                    aria-pressed={modelType === 'thinking'}
                  >
                    ☁️ Deep Research
                  </button>
                </div>
                <div className={styles.landingActions}>
                  <input
                    type="file"
                    ref={fileInputRef}
                    style={{ display: 'none' }}
                    onChange={handleFileSelect}
                    accept="image/*,text/*,.md,.json,.ts,.js,.tsx,.jsx"
                    multiple
                    data-testid="landing-file-input"
                    disabled={!llmReady}
                  />
                  <div
                    className={styles.iconButton}
                    onClick={() => llmReady && fileInputRef.current?.click()}
                    title={!llmReady ? 'LLM plugin not configured' : 'Attach file'}
                    style={!llmReady ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
                  >
                    <Icon name="attach" />
                  </div>
                  <div
                    className={`${styles.iconButton} ${isListening ? 'active' : ''}`}
                    onClick={() => llmReady && handleDictation()}
                    title={!llmReady ? 'LLM plugin not configured' : 'Dictate'}
                    style={!llmReady ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
                  >
                    <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
                      <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                      <line x1="12" y1="19" x2="12" y2="23"></line>
                      <line x1="8" y1="23" x2="16" y2="23"></line>
                    </svg>
                  </div>
                  <button onClick={handleSend} disabled={isLoading || !llmReady} className={styles.landingSendButton} aria-label="Send message" data-testid="send-message-button" title={!llmReady ? 'LLM plugin not configured' : 'Send message'}>
                    <svg viewBox="0 0 24 24" width="16" height="16" stroke="white" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="19" x2="12" y2="5"></line>
                      <polyline points="5 12 12 5 19 12"></polyline>
                    </svg>
                  </button>
                </div>
              </div>
            </div>

            <div className={styles.footerLinks}>
              <div className={styles.footerLink} onClick={() => navigate('prompts')} data-testid="prompt-library-link">
                <img src="public/plugins/vikshana-graft-app/img/prompt-library-icon.png" alt="Prompt Library" className={styles.iconImage} />
                <div>
                  <div className={styles.linkTitle}>Prompt Library</div>
                  <div className={styles.linkDesc}>View and manage prompts</div>
                </div>
              </div>
              <div className={styles.footerLink} onClick={() => navigate('history')} data-testid="previous-conversations-link">
                <img src="public/plugins/vikshana-graft-app/img/previous-conversations-icon.png" alt="Previous Conversations" className={styles.iconImage} />
                <div>
                  <div className={styles.linkTitle}>Previous Conversations</div>
                  <div className={styles.linkDesc}>Review your chat history</div>
                </div>
              </div>
              <div className={styles.footerLink} onClick={handleReviewPrompt} data-testid="refine-prompt-link">
                <img src="public/plugins/vikshana-graft-app/img/refine-prompt-icon.png" alt="Refine my prompt" className={styles.iconImage} />
                <div>
                  <div className={styles.linkTitle}>Refine my prompt</div>
                  <div className={styles.linkDesc}>Get prompting help</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* Chat header hidden in modal mode — Grafana's title bar + our modalHeader serve the same purpose */}
          {!panelContext && (
          <div className={styles.chatHeader} data-testid="chat-header">
            <div className={styles.headerLeft}>
              <Button variant="secondary" fill="outline" icon="arrow-left" onClick={handleReset} data-testid="back-button">
                Back
              </Button>
            </div>
            <div className={styles.chatTitle} onClick={handleReset} data-testid="chat-title">
              Graft AI Assistant
            </div>
            <div className={styles.headerRight}>
              <Button variant="secondary" fill="outline" onClick={() => navigate('history')} data-testid="history-button">
                Previous Conversations
                <Icon name="arrow-right" style={{ marginLeft: '8px' }} />
              </Button>
            </div>
          </div>
          )}
          <div
            className={styles.messageList}
            ref={messageListRef}
            onScroll={handleScroll}
          >
            {messages.map((msg, index) => {
              const isLastMessage = index === messages.length - 1;
              const isStreaming = isLastMessage && isLoading && msg.role === 'assistant';
              const messageCopied = copiedMessageIndex === index;

              const handleCopyMessage = async () => {
                await navigator.clipboard.writeText(msg.content);
                setCopiedMessageIndex(index);
                setTimeout(() => setCopiedMessageIndex(null), 2000);
              };

              // Parse thinking content
              let thinkingContent = null;
              let mainContent = msg.content;
              let isThinkingStreaming = false;

              const trimmedContent = msg.content.trimStart();
              if (msg.role === 'assistant' && trimmedContent.startsWith('<think>')) {
                const thinkEndIndex = msg.content.indexOf('</think>');
                if (thinkEndIndex !== -1) {
                  // Find where <think> actually starts in the original string (to preserve leading whitespace if needed, though usually we ignore it)
                  const thinkStartIndex = msg.content.indexOf('<think>');
                  thinkingContent = msg.content.substring(thinkStartIndex + 7, thinkEndIndex);
                  mainContent = msg.content.substring(thinkEndIndex + 8);
                  isThinkingStreaming = false; // Thinking is complete
                } else {
                  // Streaming case: </think> not found yet, treat all as thinking
                  const thinkStartIndex = msg.content.indexOf('<think>');
                  thinkingContent = msg.content.substring(thinkStartIndex + 7);
                  mainContent = '';
                  isThinkingStreaming = isStreaming; // Still streaming thinking
                }
              }

              return (
                <div key={index} className={`${styles.message} ${msg.role === 'user' ? styles.userMessage : styles.assistantMessage} `}>
                  <div className={styles.messageContent}>
                    {msg.role === 'assistant' && msg.agentPlan && (
                      <PlanBlock
                        reasoning={msg.agentPlan.reasoning}
                        steps={msg.agentPlan.steps}
                        isStreaming={!msg.agentPlanComplete}
                      />
                    )}
                    {thinkingContent !== null && (
                      <ThinkingBlock
                        content={thinkingContent}
                        isStreaming={isThinkingStreaming}
                        thinkingSeconds={msg.thinkingSeconds}
                        startTime={isThinkingStreaming ? thinkingStartTimeRef.current : null}
                      />
                    )}
                    {msg.role === 'assistant' && msg.stepToolExecutions && msg.stepToolExecutions.length > 0 && (
                      <StepToolCallContainer stepGroups={msg.stepToolExecutions} />
                    )}
                    {msg.role === 'assistant' && !msg.stepToolExecutions && msg.toolExecutions && msg.toolExecutions.length > 0 && (
                      <ToolCallContainer toolExecutions={msg.toolExecutions} theme={theme} />
                    )}
                    {mainContent && (
                      <MemoizedReactMarkdown
                        content={mainContent}
                        theme={theme}
                        onRender={scrollToBottom}
                        isStreaming={isStreaming}
                      />
                    )}
                    {isStreaming && thinkingContent === null && !mainContent && (
                      <div className={styles.thinkingIndicator}>
                        <div className={styles.thinkingDots}>
                          <svg width="32" height="24" viewBox="0 0 32 24" xmlns="http://www.w3.org/2000/svg">
                            <circle cx="4" cy="12" r="3" fill="#FF9933">
                              <animate attributeName="cy" from="12" to="12" values="12;6;12" dur="1s" repeatCount="indefinite" begin="0s" />
                            </circle>
                            <circle cx="12" cy="12" r="3" fill="#FFD633">
                              <animate attributeName="cy" from="12" to="12" values="12;6;12" dur="1s" repeatCount="indefinite" begin="0.2s" />
                            </circle>
                            <circle cx="20" cy="12" r="3" fill="#33C9C9">
                              <animate attributeName="cy" from="12" to="12" values="12;6;12" dur="1s" repeatCount="indefinite" begin="0.4s" />
                            </circle>
                            <circle cx="28" cy="12" r="3" fill="#7ACC33">
                              <animate attributeName="cy" from="12" to="12" values="12;6;12" dur="1s" repeatCount="indefinite" begin="0.6s" />
                            </circle>
                          </svg>
                        </div>
                      </div>
                    )}
                  </div>
                  {/* Display attachments for user messages */}
                  {msg.role === 'user' && msg.attachments && msg.attachments.length > 0 && (
                    <div className={styles.filePreviewList}>
                      {msg.attachments.map((attachment: { name: string; content: string; type: 'image' | 'text'; mimeType?: string }, attIndex: number) => (
                        <FilePreview
                          key={attIndex}
                          file={attachment}
                          onExpand={() => setPreviewAttachment(attachment)}
                        />
                      ))}
                    </div>
                  )}
                  {
                    msg.role === 'assistant' && !isStreaming && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        {msg.interrupted && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', color: theme.colors.warning.text, fontSize: '11px' }}>
                            <Icon name="exclamation-circle" size="sm" />
                            <span>Interrupted</span>
                          </div>
                        )}
                        <button className={styles.messageCopyButton} onClick={handleCopyMessage} title="Copy message">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                          </svg>
                          <span>{messageCopied ? 'Copied!' : 'Copy'}</span>
                        </button>
                        <button className={styles.messageCopyButton} onClick={() => handleDeleteMessage(index)} title="Delete message">
                          <Icon name="trash-alt" size="sm" />
                          <span>Delete</span>
                        </button>
                      </div>
                    )
                  }
                  {msg.role === 'user' && (
                    <div className={styles.messageActions}>
                      <button className={styles.messageActionButton} onClick={() => {
                        setInput(msg.content);
                        // Small timeout to allow state update before focus
                        setTimeout(() => {
                          const textarea = document.querySelector('textarea');
                          if (textarea) {
                            textarea.focus();
                          }
                        }, 0);
                      }} title="Edit message">
                        <Icon name="pen" size="sm" />
                      </button>
                      <button className={styles.messageActionButton} onClick={handleCopyMessage} title="Copy message">
                        <Icon name="copy" size="sm" />
                      </button>
                      <button className={styles.messageActionButton} onClick={() => handleDeleteMessage(index)} title="Delete message">
                        <Icon name="trash-alt" size="sm" />
                      </button>
                    </div>
                  )}
                </div >
              );
            })}
          </div >
          <div>
            {showScrollButton && (
              <button
                className={styles.scrollButton}
                onClick={scrollDownPage}
                title="Scroll down"
              >
                <Icon name="arrow-down" size="lg" />
              </button>
            )}
          </div>
          <div className={styles.inputArea}>
            {/* LLM Plugin not configured warning banner */}
            {!settingsLoading && !llmConfigured && (
              <Alert
                title="LLM Plugin Not Configured"
                severity="warning"
                style={{ marginBottom: '8px' }}
              >
                The Grafana LLM plugin is not configured. Please{' '}
                <a href="/plugins/grafana-llm-app" style={{ textDecoration: 'underline' }}>
                  configure the LLM plugin
                </a>{' '}
                to send messages.
              </Alert>
            )}

            {/* LLM Plugin unhealthy warning banner */}
            {!settingsLoading && llmConfigured && !llmHealthy && (
              <Alert
                title="LLM Plugin Unavailable"
                severity="error"
                style={{ marginBottom: '8px' }}
              >
                The Grafana LLM plugin is not responding. Please check the{' '}
                <a href="/plugins/grafana-llm-app" style={{ textDecoration: 'underline' }}>
                  LLM plugin configuration
                </a>.
              </Alert>
            )}
            {selectedFiles.length > 0 && (
              <div className={styles.filePreviewList}>
                {selectedFiles.map((file, index) => (
                  <FilePreview
                    key={index}
                    file={file}
                    onRemove={() => removeFile(index)}
                    onExpand={() => setPreviewAttachment(file)}
                  />
                ))}
              </div>
            )}<div className={styles.disclaimer}>
              Graft can make mistakes. Please double-check responses.
            </div>
            <div className={`${styles.inputWrapper} ${isLoading ? styles.inputWrapperLoading : ''} `}>
              <TextArea
                data-testid="chat-input"
                value={input}
                onChange={(e) => setInput(e.currentTarget.value)}
                placeholder={!llmReady ? 'Configure Grafana LLM plugin to send messages...' : 'Ask Graft'}
                rows={2}
                className={styles.textArea}
                onKeyDown={handleKeyDown}
                disabled={!llmReady}
              />
              <div className={styles.inputFooter}>
                {/* Mode toggle - shown when both models are available */}
                {llmReady && standardAvailable && thinkingAvailable && (
                  <div className={styles.inputModeToggle}>
                    <button
                      className={`${styles.inputModeButton} ${modelType === 'standard' ? styles.inputModeButtonActive : ''} `}
                      onClick={() => setModelType('standard')}
                      title="Use Standard mode"
                    >
                      ⚡️ Standard
                    </button>
                    <button
                      className={`${styles.inputModeButton} ${modelType === 'thinking' ? styles.inputModeButtonActive : ''} `}
                      onClick={() => setModelType('thinking')}
                      title="Use Deep Research mode for complex reasoning"
                    >
                      ☁️ Deep Research
                    </button>
                  </div>
                )}

                {/* Action icons on the right */}
                <div className={styles.inputActions}>
                  <input
                    type="file"
                    ref={fileInputRef}
                    style={{ display: 'none' }}
                    onChange={handleFileSelect}
                    accept="image/*,text/*,.md,.json,.ts,.js,.tsx,.jsx"
                    multiple
                    data-testid="file-input"
                    disabled={!llmReady}
                  />
                  <div
                    className={styles.iconButton}
                    onClick={() => llmReady && fileInputRef.current?.click()}
                    title={!llmReady ? 'LLM plugin not configured' : 'Attach file'}
                    style={!llmReady ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
                  >
                    <Icon name="attach" />
                  </div>
                  <div
                    className={`${styles.iconButton} ${isListening ? 'active' : ''} `}
                    onClick={() => llmReady && handleDictation()}
                    title={!llmReady ? 'LLM plugin not configured' : 'Dictate'}
                    style={!llmReady ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
                  >
                    <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
                      <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                      <line x1="12" y1="19" x2="12" y2="23"></line>
                      <line x1="8" y1="23" x2="16" y2="23"></line>
                    </svg>
                  </div>
                  <div
                    className={styles.sendIconButton}
                    onClick={isLoading ? handleStop : (llmReady ? handleSend : undefined)}
                    title={!llmReady ? 'LLM plugin not configured' : (isLoading ? "Stop" : "Send")}
                    style={!llmReady ? { opacity: 0.5, cursor: 'not-allowed' } : (isLoading ? { background: theme.colors.secondary.main } : undefined)}
                  >
                    {isLoading ? (
                      <div style={{ width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <div style={{ width: 10, height: 10, backgroundColor: theme.colors.error.main, borderRadius: 2 }}></div>
                      </div>
                    ) : (
                      <svg viewBox="0 0 24 24" width="16" height="16" stroke="white" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="12" y1="19" x2="12" y2="5"></line>
                        <polyline points="5 12 12 5 19 12"></polyline>
                      </svg>
                    )}
                  </div>
                </div>
              </div>
            </div>
            <div ref={messagesEndRef} />
          </div>
        </>
      )}

      <ConfirmModal
        isOpen={deleteModalOpen}
        title="Delete Message"
        body="Are you sure you want to delete this message? This action cannot be undone."
        confirmText="Delete"
        onConfirm={confirmDelete}
        onDismiss={cancelDelete}
      />
      {previewAttachment && (
        <AttachmentModal
          isOpen={true}
          attachment={previewAttachment}
          onClose={() => setPreviewAttachment(null)}
        />
      )}
    </div>
  );
};
