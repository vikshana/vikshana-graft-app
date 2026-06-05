import React, { useState, useEffect, useRef, useCallback } from 'react';
import { BuildBadge } from './components/BuildBadge';
import { CodeBlock } from './components/CodeBlock';
import { MermaidBlock } from './components/MermaidBlock';
import { ThinkingBlock } from './components/ThinkingBlock';
import { ToolCallContainer } from './components/ToolCallContainer';
import { FilePreview } from './components/FilePreview';
import { AttachmentModal } from './components/AttachmentModal';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { useSearchParams, useNavigate, useLocation } from 'react-router-dom';

// Grafana packages
import { locationService } from '@grafana/runtime';
import { Alert, Button, TextArea, useStyles2, useTheme2, Icon, ConfirmModal } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { mcp } from '@grafana/llm';

// Local services
import { llmService, runSimpleConversationalChat } from '../../../services/llm';
import type { Message, ToolExecution } from '../../../types/llm.types';
import { contextService, UserContext, DataSourceContext, DashboardContext } from '../../../services/context';
import { chatHistoryService, prepareMessagesForStorage } from '../../../services/chatHistory';
import { PLUGIN_BASE_URL } from '../../../constants';
import { replaceChatSessionInUrl } from '../../../utils/chatSessionUrl';
import { truncateMessages } from '../../../services/truncation';
import { runGraftChatTurn } from '../../../services/graftChatTurn';
import {
    CONTINUE_USER_MESSAGE,
    hasSuccessfulDashboardSave,
    isSyntheticContinueUserMessage,
    MAX_UI_AUTO_CONTINUE_ROUNDS,
    responseNeedsContinueAction,
} from '../../../services/continueAction';
import { ContinueActionBanner } from './ContinueActionBanner';
import {
  appendDashboardReferencesToReply,
  appendSaveVerificationWarning,
} from '../../../services/appendToolReferences';
import { filterTools } from '../../../services/toolFilter';
import { isSimpleConversationalMessage } from '../../../services/programmaticChatIntents';
import { latestNonContinueUserMessage } from '../../../services/dashboardCloneProgress';
import { extractDashboardUidFromMessage } from '../../../services/dashboardMentionParse';
import { clearActiveCloneIntent } from '../../../services/cloneSessionStorage';
import { GRAFT_BUILD_NUMBER } from '../../../buildInfo';
import {
  formatSinglePanelCopyClarification,
  messageMentionsSinglePanelCopyIntent,
  isExplicitSinglePanelCopyRequest,
  parseSinglePanelCopyRequest,
} from '../../../services/singlePanelCopyParse';
import {
  formatSinglePanelCopyReply,
  runProgrammaticSinglePanelCopy,
} from '../../../services/programmaticSinglePanelCopy';
import {
  formatPanelJsonDuplicateClarification,
  messageMentionsPanelJsonDuplicateIntent,
  parsePanelJsonDuplicateRequest,
} from '../../../services/panelJsonDuplicateParse';
import {
  formatPanelJsonDuplicateReply,
  runProgrammaticPanelJsonDuplicate,
} from '../../../services/programmaticPanelJsonDuplicate';
import { recordGraftFailure } from '../../../services/graftOperatorFailureLog';
import {
  messageMentionsInfluxPanelRepair,
  parseInfluxPanelRepairRequest,
} from '../../../services/influxPanelRepairParse';
import {
  formatInfluxPanelRepairReply,
  runProgrammaticInfluxPanelRepair,
} from '../../../services/programmaticInfluxPanelRepair';
import {
  formatBulkPeerBandFixClarification,
  parseBulkPeerBandFixRequest,
  userWantsBulkPeerBandFix,
} from '../../../services/bulkPeerBandFixParse';
import {
  formatBulkPeerBandFixReply,
  runProgrammaticBulkPeerBandFix,
} from '../../../services/programmaticBulkPeerBandFix';
import {
  formatAddPeerRfPanelExamplePrompt,
  parseAddPeerRfPanelRequest,
  messageMentionsAddPeerRfPanel,
} from '../../../services/peerRfPanelAddParse';
import {
  formatAddPeerRfPanelReply,
  runProgrammaticAddPeerRfPanel,
} from '../../../services/programmaticAddPeerRfPanel';
import {
  parseModulePanelReorderRequest,
  isModuleReorderConfirmation,
  userWantsModulePanelReorder,
  formatModulePanelReorderExamplePrompt,
} from '../../../services/modulePanelReorderParse';
import {
  runProgrammaticModulePanelReorder,
  formatModulePanelReorderReply,
} from '../../../services/programmaticModulePanelReorder';
import {
  parseBulkModulePanelMatchRequest,
  userWantsBulkModulePanelMatch,
  formatBulkModulePanelMatchExamplePrompt,
} from '../../../services/bulkModulePanelMatchParse';
import {
  runProgrammaticBulkModulePanelMatch,
  formatBulkModulePanelMatchReply,
} from '../../../services/programmaticBulkModulePanelMatch';
import {
  parseAddOwnHistoryPanelRequest,
  parseBulkOwnHistoryPanelCopyRequest,
  parseOwnHistoryNamingRequest,
  userWantsBulkOwnHistoryPanelCopy,
  userWantsOwnHistoryCanonicalNaming,
  messageMentionsOwnHistoryPanel,
  formatAddOwnHistoryPanelExamplePrompt,
} from '../../../services/ownHistoryPanelParse';
import {
  runProgrammaticAddOwnHistoryPanel,
  runProgrammaticBulkOwnHistoryPanelCopy,
  runProgrammaticOwnHistoryCanonicalNaming,
  formatAddOwnHistoryPanelReply,
  formatBulkOwnHistoryPanelReply,
  formatOwnHistoryNamingReply,
} from '../../../services/programmaticOwnHistoryPanel';
import { buildPowerTechOperatorGuide } from '../../../services/graftPowerTechGuide';
import {
  clearPendingDashboardTask,
  resolveEffectiveUserMessage,
} from '../../../services/dashboardPendingTask';

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

const formatContext = (dashboard: DashboardContext, user: UserContext, dataSources: DataSourceContext[]): string => {
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
    `do not narrate your next step in text ("I will now update...", "Next I will..."). ` +
    `Only respond with text when the task is fully complete or you need clarification. ` +
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

  if (user?.login) {
    lines.push(`User: ${user.name || user.login} | Role: ${user.orgRole}`);
  }

  if (dashboard.uid) {
    const version = dashboard.json?.version;
    lines.push(
      `Active dashboard: "${dashboard.title}" (uid: ${dashboard.uid}` +
        `${version != null ? `, version: ${version}` : ''})`
    );
    lines.push(
      `When calling update_dashboard for this dashboard, you MUST include the current uid "${dashboard.uid}"` +
        `${version != null ? ` and version ${version} (Grafana increments on save)` : ''}. ` +
        `Always call get_dashboard_by_uid immediately before update_dashboard to get the latest version.`
    );
  } else {
    lines.push(
      'No dashboard is active in context. Before editing, call search_dashboards or ask which dashboard to change.'
    );
  }

  // Datasource-to-tool mapping
  if (dataSources?.length > 0) {
    lines.push('');
    lines.push('Available datasources:');
    dataSources.forEach(ds => {
      let toolHint = '';
      if (ds.type === 'prometheus') { toolHint = ' → query_prometheus, list_prometheus_*'; }
      else if (ds.type === 'loki')  { toolHint = ' → query_loki_logs, list_loki_*'; }
      lines.push(`- ${ds.name} (${ds.type}, uid: ${ds.uid})${toolHint}`);
    });
  }

  // Query guidance
  lines.push('');
  lines.push('Query guidance:');
  lines.push('- Prometheus: PromQL. Call list_prometheus_metric_names before querying unknown metrics.');
  lines.push('- Loki: LogQL. Call list_loki_label_names/values to discover labels before querying.');
  lines.push('- Time ranges: use Grafana relative format ("now-1h" / "now"). Default to last 1 hour unless the user specifies otherwise.');

  // Dashboard lookup / editing
  lines.push('');
  lines.push('Dashboard lookup:');
  lines.push(
    `- After search_dashboards: call get_dashboard_summary for the target uid so the user sees the panel index table (arrayIndex, panelId, title). The UI also shows this table automatically — still mention uid in your reply.`
  );
  lines.push(
    `- NEVER claim panels were updated or titles changed unless update_dashboard succeeded in this turn (check tool steps). If you only planned changes, say so.`
  );
  lines.push(
    `- When the user provides dashboard uid and panel index/panelId, skip search — use get_dashboard_by_uid or get_dashboard_summary directly.`
  );
  lines.push(
    `- Tell users they can speed up edits by including: dashboard uid, panel arrayIndex (0-based), and/or panelId from the index table.`
  );
  lines.push('');
  lines.push('Dashboard editing:');
  lines.push(
    `- NEVER tell the user a dashboard was saved unless update_dashboard returned uid and version in the same turn.`
  );
  lines.push(
    `- After update_dashboard succeeds, tell the user to refresh the dashboard page (or hard-refresh) to see changes.`
  );
  lines.push(
    `- To modify an existing dashboard: call get_dashboard_by_uid first (use uid from context), then update_dashboard with the FULL dashboard JSON including version.`
  );
  lines.push(
    `- To create a new dashboard: build incrementally — minimal update_dashboard, get_dashboard_by_uid for new uid, then add panels one at a time (fetch, append, update).`
  );
  lines.push(
    `- When the user asks you to create or change something, use update_dashboard via tools. Do not paste JSON for manual copy unless tools fail.`
  );
  lines.push(
    `- Multiple panels: call get_dashboard_by_uid once, apply ALL panel changes, then update_dashboard. ` +
      `Prefer one update_dashboard with every panel change over many separate saves. ` +
      `If you must save one panel at a time, call update_dashboard for panel 1 before writing text about panel 2 — never stop after search/planning text.`
  );

  // PromQL anomaly detection (grafana/promql-anomaly-detection)
  lines.push('');
  lines.push('PromQL anomaly detection panels:');
  lines.push('- Metrics must be tagged with anomaly_name (required) and optionally anomaly_strategy (adaptive or robust).');
  lines.push('- Recording rules in Prometheus produce anomaly:lower_band, anomaly:upper_band, and anomaly:level series.');
  lines.push('- An anomaly panel is a time series with multiple targets on the same chart:');
  lines.push('  1) Raw metric: {job="$job", anomaly_name="$anomaly_name", anomaly_strategy="$anomaly_strategy", anomaly_select=""}');
  lines.push('  2) Lower band: last_over_time(anomaly:lower_band{job="$job", anomaly_name="$anomaly_name", anomaly_strategy="$anomaly_strategy"}[2m])');
  lines.push('  3) Upper band: last_over_time(anomaly:upper_band{job="$job", anomaly_name="$anomaly_name", anomaly_strategy="$anomaly_strategy"}[2m])');
  lines.push('- Use field overrides so upper/lower bands are semi-transparent fills; name them anomaly_upper_band and anomaly_lower_band.');
  lines.push('- Use robust strategy for spiky/non-normal signals; adaptive for normally distributed metrics.');
  lines.push('- Bands need ~24h of data before they are reliable. Mention this if bands look too wide or narrow.');
  lines.push('- To add an anomaly panel: get_dashboard_by_uid, append one timeseries panel with the queries above, update_dashboard. Do not stop after describing the steps.');

  lines.push('');
  lines.push('Influx Flux vs Prometheus (PowerTech):');
  lines.push(
    '- Queries with from(bucket: v.bucket) are Influx Flux — datasource must be the same Influx source as working peer-band panels, NOT Prometheus.'
  );
  lines.push(
    '- Putting Flux in expr/rawQuery on a Prometheus datasource causes: parse error unexpected identifier "v". Copy datasource from a working Flux panel; use query + rawQuery strings (not rawQuery: true); do not set panel timeFrom/timeTo.'
  );
  lines.push(
    '- History Comparison (live): PromQL machine_metrics + last_over_time(machine_metric_*[6m]). Older ranges: Flux actual + ml_predictions in Influx; use dashboard time picker only (no panel timeFrom/timeTo).'
  );

  lines.push('');
  lines.push(buildPowerTechOperatorGuide());
  lines.push('');
  lines.push('Hybrid workflow (LLM + programmatic tools):');
  lines.push(
    '- Repeatable layout/fixes may run without you; for novel edits you must still call get_dashboard_by_uid then update_dashboard.'
  );
  lines.push(
    '- If you asked the user a yes/no or layout question and they confirm with a short reply (yes, in order, including all, Continue), execute the full original request immediately — do not ask what to order again.'
  );
  lines.push(
    '- Never answer with generic "need more context" when the prior turn already listed panels and asked one confirmation question.'
  );

  return lines.join('\n');
};





const MemoizedReactMarkdown = React.memo(({ content, theme, onRender, isStreaming }: { content: string; theme: GrafanaTheme2; onRender: () => void; isStreaming: boolean }) => {
  const components = React.useMemo(() => ({
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

export const ChatInterface = () => {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [autoContinuing, setAutoContinuing] = useState(false);
  const lastVisibleMessageIndex = React.useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (!isSyntheticContinueUserMessage(messages[i])) {
        return i;
      }
    }
    return -1;
  }, [messages]);
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
  const messagesRef = useRef<Message[]>([]);
  const pendingSendContentRef = useRef<string | null>(null);
  const currentSessionIdRef = useRef<string | undefined>();
  const urlSyncedRef = useRef(false);
  const historyHydratedRef = useRef(false);
  const [selectedFiles, setSelectedFiles] = useState<Array<{ name: string; content: string; type: 'image' | 'text'; mimeType?: string }>>([]);
  const [modelType, setModelType] = useState<'standard' | 'thinking'>('standard');
  const [previewAttachment, setPreviewAttachment] = useState<{ name: string; content: string; type: 'image' | 'text'; mimeType?: string } | null>(null);

  // Use custom hooks - check LLM plugin health and model availability
  const { llmConfigured, llmHealthy, standardAvailable, thinkingAvailable, isLoading: settingsLoading } = usePluginSettings();
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
        const tools = filterTools(mcp.convertToolsToOpenAI(response.tools));
        setMcpTools(tools);
      }).catch(() => {
        // MCP tools loading failed - continue without tools
      });
    }
  }, [mcpEnabled, mcpClient]);

  // Use rolling placeholder hook for animated text
  const rollingPlaceholder = useRollingPlaceholder();

  // Get user context for personalized greeting
  const userContext = contextService.getUserContext();
  const userName = userContext.name || userContext.login;
  const greetingMessage = getGreetingMessage(userName);

  // Auto-select the only available model when settings load
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

  // Keep refs current for persist-on-leave (Grafana unmounts the plugin when opening a dashboard)
  messagesRef.current = messages;
  currentSessionIdRef.current = currentSessionId;

  const applyRestoredSession = useCallback((restored: { sessionId: string; messages: Message[] }) => {
    if (messagesRef.current.length > 0) {
      return;
    }
    messagesRef.current = restored.messages;
    setMessages(restored.messages);
    setCurrentSessionId(restored.sessionId);
    currentSessionIdRef.current = restored.sessionId;
    replaceChatSessionInUrl(restored.sessionId);
  }, []);

  const persistActiveSession = useCallback(() => {
    const msgs = prepareMessagesForStorage(messagesRef.current);
    if (msgs.length === 0) {
      return;
    }
    const saved = chatHistoryService.saveSession(msgs, currentSessionIdRef.current);
    if (saved) {
      currentSessionIdRef.current = saved.id;
    }
    void chatHistoryService.flushToServer();
  }, []);

  // Save whenever messages change (Grafana often does not fire pagehide when switching to a dashboard)
  useEffect(() => {
    if (messages.length === 0) {
      return;
    }
    messagesRef.current = messages;
    const timer = window.setTimeout(() => persistActiveSession(), 300);
    return () => {
      window.clearTimeout(timer);
      persistActiveSession();
    };
  }, [messages, currentSessionId, persistActiveSession]);

  // Load history from plugin backend, then restore last session or URL session
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await chatHistoryService.ensureLoaded();
      if (cancelled || historyHydratedRef.current) {
        return;
      }
      historyHydratedRef.current = true;

      const sessionId = searchParams.get('session');
      if (sessionId) {
        const session = chatHistoryService.getSession(sessionId);
        if (session) {
          applyRestoredSession({ sessionId: session.id, messages: session.messages });
          urlSyncedRef.current = true;
          return;
        }
      }

      if (messagesRef.current.length === 0) {
        const restored = chatHistoryService.loadLastActiveSession();
        if (restored) {
          applyRestoredSession(restored);
        }
      }
      urlSyncedRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, [applyRestoredSession, searchParams]);

  // Restore when Grafana navigates back to this app (use locationService — router pathname is only "/")
  useEffect(() => {
    const tryRestore = async () => {
      const path = locationService.getLocation().pathname || '';
      if (!path.includes(PLUGIN_BASE_URL)) {
        return;
      }
      if (messagesRef.current.length > 0) {
        return;
      }
      await chatHistoryService.ensureLoaded();
      const restored = chatHistoryService.loadLastActiveSession();
      if (restored) {
        applyRestoredSession(restored);
      }
    };

    void tryRestore();
  }, [applyRestoredSession]);

  // Persist when leaving the Grafana app route (dashboard, explore, etc.)
  useEffect(() => {
    const history = locationService.getHistory();
    const unlisten = history.listen((loc) => {
      const path = loc.pathname || '';
      if (!path.includes(PLUGIN_BASE_URL)) {
        persistActiveSession();
      }
    });

    const onHide = () => persistActiveSession();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        onHide();
      }
    };

    window.addEventListener('pagehide', onHide);
    window.addEventListener('beforeunload', onHide);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      unlisten();
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('beforeunload', onHide);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      onHide();
    };
  }, [persistActiveSession]);

  // Sync URL when opening a session from Previous Conversations after hydration
  useEffect(() => {
    if (!historyHydratedRef.current) {
      return;
    }
    const sessionId =
      new URLSearchParams(window.location.search).get('session') ?? searchParams.get('session');
    if (!sessionId) {
      return;
    }
    const session = chatHistoryService.getSession(sessionId);
    if (
      session &&
      session.id !== currentSessionIdRef.current &&
      messagesRef.current.length === 0
    ) {
      applyRestoredSession({ sessionId: session.id, messages: session.messages });
    } else if (sessionId) {
      replaceChatSessionInUrl(sessionId);
    }
  }, [searchParams, applyRestoredSession]);

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
    const pendingContent = pendingSendContentRef.current;
    pendingSendContentRef.current = null;
    const messageText = pendingContent ?? input;
    if (!messageText.trim()) {
      return;
    }
    if (!pendingContent) {
      setInput('');
    }

    let content = messageText;
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

    const lastAssistantBeforeSend =
      [...messages].reverse().find((m) => m.role === 'assistant')?.content ?? '';
    const priorUserMessages = messages.filter((m) => m.role === 'user').map((m) => m.content);

    if (/^continue\.?$/i.test(content.trim())) {
      const prior = latestNonContinueUserMessage(priorUserMessages);
      const assistantBeforeContinue = lastAssistantBeforeSend;
      const pendingResolved = resolveEffectiveUserMessage('Continue', {
        priorUserMessages,
        lastAssistantMessage: assistantBeforeContinue,
      });
      if (pendingResolved.replaced) {
        content = pendingResolved.effective;
      } else if (
        prior &&
        (parseSinglePanelCopyRequest(prior) ||
          isExplicitSinglePanelCopyRequest(prior) ||
          parseBulkPeerBandFixRequest(prior) ||
          parseAddPeerRfPanelRequest(prior) ||
          userWantsModulePanelReorder(prior) ||
          parseModulePanelReorderRequest(prior, {
            priorUserMessage: prior,
            priorAssistantMessage: assistantBeforeContinue,
          }))
      ) {
        content = prior;
      } else {
        content =
          'Continue the previous task. Use tools immediately to finish any remaining dashboard or panel updates. ' +
          'Call get_dashboard_by_uid for the latest version, then update_dashboard. Do not repeat earlier searches unless needed.';
      }
    } else {
      const resolved = resolveEffectiveUserMessage(content, {
        priorUserMessages,
        lastAssistantMessage: lastAssistantBeforeSend,
      });
      if (resolved.replaced) {
        content = resolved.effective;
      }
    }

    const userMessage: Message = {
      role: 'user',
      content: messageText.trim(),
      attachments: attachments.length > 0 ? attachments : undefined,
    };
    const newMessages = [...messages, userMessage];

    messagesRef.current = newMessages;
    setMessages(newMessages);
    setInput('');
    clearFiles();
    setIsLoading(true);

    // Save immediately so history survives navigation before the LLM finishes
    const draftSession = chatHistoryService.saveSession(newMessages, currentSessionId);
    if (!draftSession) {
      return;
    }
    setCurrentSessionId(draftSession.id);
    currentSessionIdRef.current = draftSession.id;
    replaceChatSessionInUrl(draftSession.id);

    let usedSimpleChatPath = false;
    let errorPathTag = 'full-llm';

    try {
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
      const clearPendingOnProgrammaticSuccess = (ok: boolean) => {
        if (ok) {
          clearPendingDashboardTask();
        }
      };

      if (isSimpleConversationalMessage(content)) {
        usedSimpleChatPath = true;
        finalContent = await runSimpleConversationalChat(content, modelType, controller.signal);
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === 'assistant') {
            updated[updated.length - 1] = { ...last, content: finalContent };
          }
          return updated;
        });

        const finalAssistantMessage: Message = {
          role: 'assistant',
          content: finalContent,
        };
        const finalMessages = [...newMessages, finalAssistantMessage];
        const savedSession = chatHistoryService.saveSession(finalMessages, currentSessionId);
        if (savedSession) {
          setCurrentSessionId(savedSession.id);
          currentSessionIdRef.current = savedSession.id;
          replaceChatSessionInUrl(savedSession.id);
        }
        return;
      }

      const explicitSinglePanelCopy = isExplicitSinglePanelCopyRequest(content);
      const panelCopyRequest = parseSinglePanelCopyRequest(content);
      if (explicitSinglePanelCopy || messageMentionsSinglePanelCopyIntent(content)) {
        clearActiveCloneIntent();
        errorPathTag = 'single-panel-copy';
      }
      if (explicitSinglePanelCopy && !panelCopyRequest) {
        finalContent = formatSinglePanelCopyClarification(content);
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === 'assistant') {
            updated[updated.length - 1] = { ...last, content: finalContent };
          }
          return updated;
        });
        const finalAssistantMessage: Message = { role: 'assistant', content: finalContent };
        const savedSession = chatHistoryService.saveSession(
          [...newMessages, finalAssistantMessage],
          currentSessionId
        );
        if (savedSession) {
          setCurrentSessionId(savedSession.id);
          currentSessionIdRef.current = savedSession.id;
          replaceChatSessionInUrl(savedSession.id);
        }
        return;
      }
      if (messageMentionsSinglePanelCopyIntent(content) && !panelCopyRequest) {
        finalContent = formatSinglePanelCopyClarification(content);
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === 'assistant') {
            updated[updated.length - 1] = { ...last, content: finalContent };
          }
          return updated;
        });
        const finalAssistantMessage: Message = { role: 'assistant', content: finalContent };
        const savedSession = chatHistoryService.saveSession(
          [...newMessages, finalAssistantMessage],
          currentSessionId
        );
        if (savedSession) {
          setCurrentSessionId(savedSession.id);
          currentSessionIdRef.current = savedSession.id;
          replaceChatSessionInUrl(savedSession.id);
        }
        return;
      }

      if (panelCopyRequest || explicitSinglePanelCopy) {
        if (!panelCopyRequest) {
          finalContent = formatSinglePanelCopyClarification(content);
        } else if (!mcpClient) {
          finalContent =
            '### Could not copy panel\n\nGrafana MCP tools are not connected. Open **Grafana LLM / MCP settings**, enable MCP for Graft, hard-refresh, then try again.';
        } else {
          const copyResult = await runProgrammaticSinglePanelCopy(mcpClient, panelCopyRequest);
          finalContent = formatSinglePanelCopyReply(copyResult, GRAFT_BUILD_NUMBER);
          finalToolExecutions = copyResult.toolExecutions;
          clearPendingOnProgrammaticSuccess(copyResult.ok);
          if (!copyResult.ok) {
            recordGraftFailure({
              buildNumber: GRAFT_BUILD_NUMBER,
              intent: 'single_panel_copy',
              userMessagePreview: content,
              error: copyResult.error ?? 'Unknown error',
              panelTitle: copyResult.panelTitle,
            });
          }
        }
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === 'assistant') {
            updated[updated.length - 1] = {
              ...last,
              content: finalContent,
              toolExecutions:
                finalToolExecutions.length > 0 ? finalToolExecutions : undefined,
            };
          }
          return updated;
        });
        const finalAssistantMessage: Message = {
          role: 'assistant',
          content: finalContent,
          toolExecutions: finalToolExecutions.length > 0 ? finalToolExecutions : undefined,
        };
        const savedSession = chatHistoryService.saveSession(
          [...newMessages, finalAssistantMessage],
          currentSessionId
        );
        if (savedSession) {
          setCurrentSessionId(savedSession.id);
          currentSessionIdRef.current = savedSession.id;
          replaceChatSessionInUrl(savedSession.id);
        }
        return;
      }

      const addOwnHistoryRequestEarly = parseAddOwnHistoryPanelRequest(content);
      if (
        addOwnHistoryRequestEarly &&
        !userWantsBulkOwnHistoryPanelCopy(content) &&
        !userWantsOwnHistoryCanonicalNaming(content)
      ) {
        errorPathTag = 'add-own-history-panel';
        if (!mcpClient) {
          finalContent = '### Could not add Own History panel\n\nGrafana MCP tools are not connected.';
        } else {
          const addResult = await runProgrammaticAddOwnHistoryPanel(mcpClient, addOwnHistoryRequestEarly);
          finalContent = formatAddOwnHistoryPanelReply(addResult, GRAFT_BUILD_NUMBER);
          finalToolExecutions = addResult.toolExecutions;
          clearPendingOnProgrammaticSuccess(addResult.ok);
        }
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === 'assistant') {
            updated[updated.length - 1] = {
              ...last,
              content: finalContent,
              toolExecutions: finalToolExecutions.length > 0 ? finalToolExecutions : undefined,
            };
          }
          return updated;
        });
        const finalAssistantMessage: Message = {
          role: 'assistant',
          content: finalContent,
          toolExecutions: finalToolExecutions.length > 0 ? finalToolExecutions : undefined,
        };
        const savedSession = chatHistoryService.saveSession(
          [...newMessages, finalAssistantMessage],
          currentSessionId
        );
        if (savedSession) {
          setCurrentSessionId(savedSession.id);
          currentSessionIdRef.current = savedSession.id;
          replaceChatSessionInUrl(savedSession.id);
        }
        return;
      }

      const ownHistoryNamingRequest = parseOwnHistoryNamingRequest(content);
      if (userWantsOwnHistoryCanonicalNaming(content) && ownHistoryNamingRequest && mcpClient) {
        errorPathTag = 'own-history-naming';
        const uid =
          ownHistoryNamingRequest.dashboardUid ??
          (await (async () => {
            const addReq = parseAddOwnHistoryPanelRequest(content);
            return addReq?.dashboardUid;
          })()) ??
          '6gawrgawrgragg';
        const namingResult = await runProgrammaticOwnHistoryCanonicalNaming(mcpClient, uid);
        finalContent = formatOwnHistoryNamingReply(namingResult, GRAFT_BUILD_NUMBER);
        finalToolExecutions = namingResult.toolExecutions;
        clearPendingOnProgrammaticSuccess(namingResult.ok);
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === 'assistant') {
            updated[updated.length - 1] = {
              ...last,
              content: finalContent,
              toolExecutions: finalToolExecutions.length > 0 ? finalToolExecutions : undefined,
            };
          }
          return updated;
        });
        const finalAssistantMessage: Message = {
          role: 'assistant',
          content: finalContent,
          toolExecutions: finalToolExecutions.length > 0 ? finalToolExecutions : undefined,
        };
        const savedSession = chatHistoryService.saveSession(
          [...newMessages, finalAssistantMessage],
          currentSessionId
        );
        if (savedSession) {
          setCurrentSessionId(savedSession.id);
          currentSessionIdRef.current = savedSession.id;
          replaceChatSessionInUrl(savedSession.id);
        }
        return;
      }

      const bulkOwnHistoryCopyRequest = parseBulkOwnHistoryPanelCopyRequest(content);
      if (userWantsBulkOwnHistoryPanelCopy(content) && bulkOwnHistoryCopyRequest && mcpClient) {
        errorPathTag = 'bulk-own-history-copy';
        const copyResult = await runProgrammaticBulkOwnHistoryPanelCopy(
          mcpClient,
          bulkOwnHistoryCopyRequest
        );
        finalContent = formatBulkOwnHistoryPanelReply(copyResult, GRAFT_BUILD_NUMBER);
        finalToolExecutions = copyResult.toolExecutions;
        clearPendingOnProgrammaticSuccess(copyResult.ok);
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === 'assistant') {
            updated[updated.length - 1] = {
              ...last,
              content: finalContent,
              toolExecutions: finalToolExecutions.length > 0 ? finalToolExecutions : undefined,
            };
          }
          return updated;
        });
        const finalAssistantMessage: Message = {
          role: 'assistant',
          content: finalContent,
          toolExecutions: finalToolExecutions.length > 0 ? finalToolExecutions : undefined,
        };
        const savedSession = chatHistoryService.saveSession(
          [...newMessages, finalAssistantMessage],
          currentSessionId
        );
        if (savedSession) {
          setCurrentSessionId(savedSession.id);
          currentSessionIdRef.current = savedSession.id;
          replaceChatSessionInUrl(savedSession.id);
        }
        return;
      }

      if (messageMentionsOwnHistoryPanel(content) && /\b(add|create|new)\b/i.test(content) && !addOwnHistoryRequestEarly) {
        finalContent =
          `### Need clarification\n\n` + formatAddOwnHistoryPanelExamplePrompt();
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === 'assistant') {
            updated[updated.length - 1] = { ...last, content: finalContent };
          }
          return updated;
        });
        const finalAssistantMessage: Message = { role: 'assistant', content: finalContent };
        const savedSession = chatHistoryService.saveSession(
          [...newMessages, finalAssistantMessage],
          currentSessionId
        );
        if (savedSession) {
          setCurrentSessionId(savedSession.id);
          currentSessionIdRef.current = savedSession.id;
          replaceChatSessionInUrl(savedSession.id);
        }
        return;
      }

      const bulkModulePanelMatchRequest = parseBulkModulePanelMatchRequest(content);
      if (userWantsBulkModulePanelMatch(content)) {
        errorPathTag = 'bulk-module-panel-match';
      }
      if (userWantsBulkModulePanelMatch(content) && !bulkModulePanelMatchRequest) {
        finalContent =
          `### Need clarification\n\n` +
          `Say which dashboard and which modules should match Module 5, e.g.:\n\n\`\`\`text\n${formatBulkModulePanelMatchExamplePrompt()}\n\`\`\``;
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === 'assistant') {
            updated[updated.length - 1] = { ...last, content: finalContent };
          }
          return updated;
        });
        const finalAssistantMessage: Message = { role: 'assistant', content: finalContent };
        const savedSession = chatHistoryService.saveSession(
          [...newMessages, finalAssistantMessage],
          currentSessionId
        );
        if (savedSession) {
          setCurrentSessionId(savedSession.id);
          currentSessionIdRef.current = savedSession.id;
          replaceChatSessionInUrl(savedSession.id);
        }
        return;
      }
      if (bulkModulePanelMatchRequest) {
        if (!mcpClient) {
          finalContent = '### Could not match Module panels\n\nGrafana MCP tools are not connected.';
        } else {
          const matchResult = await runProgrammaticBulkModulePanelMatch(mcpClient, bulkModulePanelMatchRequest);
          finalContent = formatBulkModulePanelMatchReply(matchResult, GRAFT_BUILD_NUMBER);
          finalToolExecutions = matchResult.toolExecutions;
          clearPendingOnProgrammaticSuccess(matchResult.ok);
        }
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === 'assistant') {
            updated[updated.length - 1] = {
              ...last,
              content: finalContent,
              toolExecutions: finalToolExecutions.length > 0 ? finalToolExecutions : undefined,
            };
          }
          return updated;
        });
        const finalAssistantMessage: Message = {
          role: 'assistant',
          content: finalContent,
          toolExecutions: finalToolExecutions.length > 0 ? finalToolExecutions : undefined,
        };
        const savedSession = chatHistoryService.saveSession(
          [...newMessages, finalAssistantMessage],
          currentSessionId
        );
        if (savedSession) {
          setCurrentSessionId(savedSession.id);
          currentSessionIdRef.current = savedSession.id;
          replaceChatSessionInUrl(savedSession.id);
        }
        return;
      }

      const moduleReorderRequest = parseModulePanelReorderRequest(content, {
        priorUserMessage: latestNonContinueUserMessage(priorUserMessages),
        priorAssistantMessage: lastAssistantBeforeSend,
      });
      if (userWantsModulePanelReorder(content) || isModuleReorderConfirmation(content)) {
        errorPathTag = 'module-panel-reorder';
      }
      if (
        (userWantsModulePanelReorder(content) || isModuleReorderConfirmation(content)) &&
        !moduleReorderRequest
      ) {
        finalContent =
          `### Need clarification\n\n` +
          `Say which dashboard to reorder (machine id or title), e.g.:\n\n\`\`\`text\n${formatModulePanelReorderExamplePrompt()}\n\`\`\``;
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === 'assistant') {
            updated[updated.length - 1] = { ...last, content: finalContent };
          }
          return updated;
        });
        const finalAssistantMessage: Message = { role: 'assistant', content: finalContent };
        const savedSession = chatHistoryService.saveSession(
          [...newMessages, finalAssistantMessage],
          currentSessionId
        );
        if (savedSession) {
          setCurrentSessionId(savedSession.id);
          currentSessionIdRef.current = savedSession.id;
          replaceChatSessionInUrl(savedSession.id);
        }
        return;
      }
      if (moduleReorderRequest) {
        if (!mcpClient) {
          finalContent = '### Could not reorder panels\n\nGrafana MCP tools are not connected.';
        } else {
          const reorderResult = await runProgrammaticModulePanelReorder(mcpClient, moduleReorderRequest);
          finalContent = formatModulePanelReorderReply(reorderResult, GRAFT_BUILD_NUMBER);
          finalToolExecutions = reorderResult.toolExecutions;
          clearPendingOnProgrammaticSuccess(reorderResult.ok);
        }
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === 'assistant') {
            updated[updated.length - 1] = {
              ...last,
              content: finalContent,
              toolExecutions: finalToolExecutions.length > 0 ? finalToolExecutions : undefined,
            };
          }
          return updated;
        });
        const finalAssistantMessage: Message = {
          role: 'assistant',
          content: finalContent,
          toolExecutions: finalToolExecutions.length > 0 ? finalToolExecutions : undefined,
        };
        const savedSession = chatHistoryService.saveSession(
          [...newMessages, finalAssistantMessage],
          currentSessionId
        );
        if (savedSession) {
          setCurrentSessionId(savedSession.id);
          currentSessionIdRef.current = savedSession.id;
          replaceChatSessionInUrl(savedSession.id);
        }
        return;
      }

      const bulkPeerBandRequest = parseBulkPeerBandFixRequest(content);
      if (userWantsBulkPeerBandFix(content)) {
        clearActiveCloneIntent();
        errorPathTag = 'bulk-peer-band-fix';
      }
      if (userWantsBulkPeerBandFix(content) && !bulkPeerBandRequest) {
        finalContent = formatBulkPeerBandFixClarification();
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === 'assistant') {
            updated[updated.length - 1] = { ...last, content: finalContent };
          }
          return updated;
        });
        const finalAssistantMessage: Message = { role: 'assistant', content: finalContent };
        const savedSession = chatHistoryService.saveSession(
          [...newMessages, finalAssistantMessage],
          currentSessionId
        );
        if (savedSession) {
          setCurrentSessionId(savedSession.id);
          currentSessionIdRef.current = savedSession.id;
          replaceChatSessionInUrl(savedSession.id);
        }
        return;
      }
      const addPeerRfRequest = parseAddPeerRfPanelRequest(content);
      if (messageMentionsAddPeerRfPanel(content) && !addPeerRfRequest) {
        finalContent =
          `### Need clarification\n\n` +
          formatAddPeerRfPanelExamplePrompt(extractDashboardUidFromMessage(content) ?? '6gawrgawrgragg');
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === 'assistant') {
            updated[updated.length - 1] = { ...last, content: finalContent };
          }
          return updated;
        });
        const finalAssistantMessage: Message = { role: 'assistant', content: finalContent };
        const savedSession = chatHistoryService.saveSession(
          [...newMessages, finalAssistantMessage],
          currentSessionId
        );
        if (savedSession) {
          setCurrentSessionId(savedSession.id);
          currentSessionIdRef.current = savedSession.id;
          replaceChatSessionInUrl(savedSession.id);
        }
        return;
      }
      if (addPeerRfRequest) {
        errorPathTag = 'add-peer-rf-panel';
        if (!mcpClient) {
          finalContent =
            '### Could not add peer-RF panel\n\nGrafana MCP tools are not connected.';
        } else {
          const addResult = await runProgrammaticAddPeerRfPanel(mcpClient, addPeerRfRequest);
          finalContent = formatAddPeerRfPanelReply(addResult, GRAFT_BUILD_NUMBER);
          finalToolExecutions = addResult.toolExecutions;
          clearPendingOnProgrammaticSuccess(addResult.ok);
        }
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === 'assistant') {
            updated[updated.length - 1] = {
              ...last,
              content: finalContent,
              toolExecutions:
                finalToolExecutions.length > 0 ? finalToolExecutions : undefined,
            };
          }
          return updated;
        });
        const finalAssistantMessage: Message = {
          role: 'assistant',
          content: finalContent,
          toolExecutions: finalToolExecutions.length > 0 ? finalToolExecutions : undefined,
        };
        const savedSession = chatHistoryService.saveSession(
          [...newMessages, finalAssistantMessage],
          currentSessionId
        );
        if (savedSession) {
          setCurrentSessionId(savedSession.id);
          currentSessionIdRef.current = savedSession.id;
          replaceChatSessionInUrl(savedSession.id);
        }
        return;
      }

      if (bulkPeerBandRequest) {
        if (!mcpClient) {
          finalContent =
            '### Could not fix peer-band panels\n\nGrafana MCP tools are not connected. Open **Grafana LLM / MCP settings**, enable MCP for Graft, hard-refresh, then try again.';
        } else {
          const bulkResult = await runProgrammaticBulkPeerBandFix(mcpClient, bulkPeerBandRequest);
          finalContent = formatBulkPeerBandFixReply(bulkResult, GRAFT_BUILD_NUMBER);
          finalToolExecutions = bulkResult.toolExecutions;
          clearPendingOnProgrammaticSuccess(bulkResult.ok);
          if (!bulkResult.ok) {
            recordGraftFailure({
              buildNumber: GRAFT_BUILD_NUMBER,
              intent: 'bulk_peer_band_fix',
              userMessagePreview: content,
              error: bulkResult.error ?? 'Unknown error',
            });
          }
        }
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === 'assistant') {
            updated[updated.length - 1] = {
              ...last,
              content: finalContent,
              toolExecutions:
                finalToolExecutions.length > 0 ? finalToolExecutions : undefined,
            };
          }
          return updated;
        });
        const finalAssistantMessage: Message = {
          role: 'assistant',
          content: finalContent,
          toolExecutions: finalToolExecutions.length > 0 ? finalToolExecutions : undefined,
        };
        const savedSession = chatHistoryService.saveSession(
          [...newMessages, finalAssistantMessage],
          currentSessionId
        );
        if (savedSession) {
          setCurrentSessionId(savedSession.id);
          currentSessionIdRef.current = savedSession.id;
          replaceChatSessionInUrl(savedSession.id);
        }
        return;
      }

      const influxPanelRepairRequest = parseInfluxPanelRepairRequest(content);
      if (messageMentionsInfluxPanelRepair(content) && influxPanelRepairRequest && mcpClient) {
        errorPathTag = 'influx-panel-repair';
        const repairResult = await runProgrammaticInfluxPanelRepair(mcpClient, influxPanelRepairRequest);
        finalContent = formatInfluxPanelRepairReply(repairResult, GRAFT_BUILD_NUMBER);
        finalToolExecutions = repairResult.toolExecutions;
        clearPendingOnProgrammaticSuccess(repairResult.ok);
        if (!repairResult.ok) {
          recordGraftFailure({
            buildNumber: GRAFT_BUILD_NUMBER,
            intent: 'influx_panel_repair',
            userMessagePreview: content,
            error: repairResult.error ?? 'Unknown error',
            dashboardTitle: repairResult.dashboardTitle,
            panelTitle: repairResult.panelTitle,
          });
        }
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === 'assistant') {
            updated[updated.length - 1] = {
              ...last,
              content: finalContent,
              toolExecutions:
                finalToolExecutions.length > 0 ? finalToolExecutions : undefined,
            };
          }
          return updated;
        });
        const finalAssistantMessage: Message = {
          role: 'assistant',
          content: finalContent,
          toolExecutions: finalToolExecutions.length > 0 ? finalToolExecutions : undefined,
        };
        const savedSession = chatHistoryService.saveSession(
          [...newMessages, finalAssistantMessage],
          currentSessionId
        );
        if (savedSession) {
          setCurrentSessionId(savedSession.id);
          currentSessionIdRef.current = savedSession.id;
          replaceChatSessionInUrl(savedSession.id);
        }
        return;
      }

      const panelJsonDuplicateRequest = parsePanelJsonDuplicateRequest(content);
      if (messageMentionsPanelJsonDuplicateIntent(content) && !panelJsonDuplicateRequest) {
        finalContent = formatPanelJsonDuplicateClarification();
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === 'assistant') {
            updated[updated.length - 1] = { ...last, content: finalContent };
          }
          return updated;
        });
        const finalAssistantMessage: Message = { role: 'assistant', content: finalContent };
        const savedSession = chatHistoryService.saveSession(
          [...newMessages, finalAssistantMessage],
          currentSessionId
        );
        if (savedSession) {
          setCurrentSessionId(savedSession.id);
          currentSessionIdRef.current = savedSession.id;
          replaceChatSessionInUrl(savedSession.id);
        }
        return;
      }

      if (panelJsonDuplicateRequest) {
        if (!mcpClient) {
          finalContent =
            '### Could not add panel from JSON\n\nGrafana MCP tools are not connected. Open **Grafana LLM / MCP settings**, enable MCP for Graft, hard-refresh, then try again.';
        } else {
          const dupResult = await runProgrammaticPanelJsonDuplicate(mcpClient, panelJsonDuplicateRequest);
          finalContent = formatPanelJsonDuplicateReply(dupResult, GRAFT_BUILD_NUMBER);
          finalToolExecutions = dupResult.toolExecutions;
          clearPendingOnProgrammaticSuccess(dupResult.ok);
          if (!dupResult.ok) {
            recordGraftFailure({
              buildNumber: GRAFT_BUILD_NUMBER,
              intent: 'panel_json_duplicate',
              userMessagePreview: content,
              error: dupResult.error ?? 'Unknown error',
              dashboardTitle: dupResult.dashboardTitle,
              panelTitle: dupResult.sourcePanelTitle,
            });
          }
        }
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === 'assistant') {
            updated[updated.length - 1] = {
              ...last,
              content: finalContent,
              toolExecutions:
                finalToolExecutions.length > 0 ? finalToolExecutions : undefined,
            };
          }
          return updated;
        });
        const finalAssistantMessage: Message = {
          role: 'assistant',
          content: finalContent,
          toolExecutions: finalToolExecutions.length > 0 ? finalToolExecutions : undefined,
        };
        const savedSession = chatHistoryService.saveSession(
          [...newMessages, finalAssistantMessage],
          currentSessionId
        );
        if (savedSession) {
          setCurrentSessionId(savedSession.id);
          currentSessionIdRef.current = savedSession.id;
          replaceChatSessionInUrl(savedSession.id);
        }
        return;
      }

      const dashboard = await contextService.getCurrentDashboard();
      const user = contextService.getUserContext();
      const dataSources = contextService.getDataSources();

      const context = formatContext(dashboard, user, dataSources);

      thinkingStartTimeRef.current = null;
      let displayContent = '';
      let messagesForContinue = newMessages;

      const streamAssistant = (fullContent: string, toolExecutions?: ToolExecution[], ts?: number) => {
        finalContent = fullContent;
        finalToolExecutions = toolExecutions || [];
        const trimmedContent = fullContent.trimStart();
        if (trimmedContent.startsWith('<think>') && thinkingStartTimeRef.current === null) {
          thinkingStartTimeRef.current = Date.now();
        }
        if (
            fullContent.includes('</think>') &&
            thinkingStartTimeRef.current !== null &&
            thinkingDuration === undefined
        ) {
            thinkingDuration = Math.floor((Date.now() - thinkingStartTimeRef.current) / 1000);
        }
        if (ts !== undefined) {
            thinkingDuration = ts;
        }
        setMessages((prev) => {
            const updated = [...prev];
            const lastMessage = updated[updated.length - 1];
            if (lastMessage?.role === 'assistant') {
                updated[updated.length - 1] = {
                    ...lastMessage,
                    content: fullContent,
                    thinkingSeconds: thinkingDuration,
                    toolExecutions: toolExecutions,
                };
            }
            return updated;
        });
      };

      const applyTurnResult = (
        turn: Awaited<ReturnType<typeof runGraftChatTurn>>,
        conversationBase: Message[]
      ) => {
        displayContent = turn.displayContent;
        finalToolExecutions = turn.toolExecutions;
        thinkingDuration = turn.thinkingSeconds;
        const assistantMessage: Message = {
            role: 'assistant',
            content: displayContent,
            thinkingSeconds: thinkingDuration,
            toolExecutions: finalToolExecutions.length > 0 ? finalToolExecutions : undefined,
        };
        messagesForContinue = [...conversationBase, assistantMessage];
        messagesRef.current = messagesForContinue;
        setMessages(messagesForContinue);
      };

      const firstTurn = await runGraftChatTurn({
        conversationMessages: newMessages,
        fallbackUserMessage: content,
        context,
        modelType,
        signal: controller.signal,
        mcpClient,
        mcpTools,
        onStream: streamAssistant,
      });
      applyTurnResult(firstTurn, newMessages);

      const originalUserContent =
        latestNonContinueUserMessage(newMessages.filter((m) => m.role === 'user').map((m) => m.content)) ??
        content;

      if (
        !isSimpleConversationalMessage(originalUserContent) &&
        responseNeedsContinueAction(displayContent) &&
        !hasSuccessfulDashboardSave(finalToolExecutions)
      ) {
        setAutoContinuing(true);
        let uiContinueRound = 0;
        while (
            uiContinueRound < MAX_UI_AUTO_CONTINUE_ROUNDS &&
            responseNeedsContinueAction(displayContent) &&
            !hasSuccessfulDashboardSave(finalToolExecutions)
        ) {
            uiContinueRound++;
            const continueUserMsg: Message = { role: 'user', content: CONTINUE_USER_MESSAGE };
            const withContinue = [...messagesForContinue, continueUserMsg];
            setMessages([...withContinue, { role: 'assistant', content: '' }]);
            messagesRef.current = [...withContinue, { role: 'assistant', content: '' }];

            const nextTurn = await runGraftChatTurn({
                conversationMessages: withContinue,
                fallbackUserMessage: originalUserContent,
                context,
                modelType,
                signal: controller.signal,
                mcpClient,
                mcpTools,
                onStream: streamAssistant,
            });
            applyTurnResult(nextTurn, withContinue);
        }
        setAutoContinuing(false);
      }

      // Save chat to history after completion
      const finalAssistantMessage: Message = {
        role: 'assistant',
        content: displayContent,
        thinkingSeconds: thinkingDuration,
        toolExecutions: finalToolExecutions.length > 0 ? finalToolExecutions : undefined
      };
      const finalMessages = messagesForContinue;
      const savedSession = chatHistoryService.saveSession(finalMessages, currentSessionId);
      if (savedSession) {
        setCurrentSessionId(savedSession.id);
        replaceChatSessionInUrl(savedSession.id);
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
        persistActiveSession();
        return;
      }
      const pathTag = usedSimpleChatPath ? '[simple-chat] ' : `[${errorPathTag}] `;
      const errorMessage = `Sorry, I encountered an error: ${pathTag}${error.message || 'Unknown error'} `;

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
      if (savedSession) {
        setCurrentSessionId(savedSession.id);
        replaceChatSessionInUrl(savedSession.id);
      }
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

    chatHistoryService.clearLastActiveSessionId();
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
      const context = await contextService.getCurrentDashboard();
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
      if (savedSession) {
        setCurrentSessionId(savedSession.id);
        replaceChatSessionInUrl(savedSession.id);
      }
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
      if (savedSession) {
        setCurrentSessionId(savedSession.id);
        replaceChatSessionInUrl(savedSession.id);
      }

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
      {messages.length === 0 ? (
        <div className={styles.landingContainer}>
          <div className={styles.landingContent}>

            <div className={styles.logo}>
              <img src="public/plugins/vikshana-graft-app/img/logo.svg" alt="Graft AI Assistant" className={styles.logoImage} />
            </div>
            <h1 className={styles.title} data-testid="landing-title">{greetingMessage}</h1>

            <h2 className={styles.subtitle}>How can I help you today?</h2>
            <BuildBadge className={styles.buildBadgeLanding} />

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
          <div className={styles.chatHeader} data-testid="chat-header">
            <div className={styles.headerLeft}>
              <Button variant="secondary" fill="outline" icon="arrow-left" onClick={handleReset} data-testid="back-button">
                Back
              </Button>
            </div>
            <div className={styles.chatTitleBlock}>
              <div className={styles.chatTitle} onClick={handleReset} data-testid="chat-title">
                Graft AI Assistant
              </div>
              <BuildBadge />
            </div>
            <div className={styles.headerRight}>
              <Button variant="secondary" fill="outline" onClick={() => navigate('history')} data-testid="history-button">
                Previous Conversations
                <Icon name="arrow-right" style={{ marginLeft: '8px' }} />
              </Button>
            </div>
          </div>
          <div className={styles.messagePane}>
          <div
            className={styles.messageList}
            ref={messageListRef}
            onScroll={handleScroll}
          >
            {messages
              .map((msg, index) => ({ msg, index }))
              .filter(({ msg }) => !isSyntheticContinueUserMessage(msg))
              .map(({ msg, index }) => {
              const isLastVisibleMessage = index === lastVisibleMessageIndex;
              const isStreaming = isLastVisibleMessage && isLoading && msg.role === 'assistant';
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
                    {thinkingContent !== null && (
                      <ThinkingBlock
                        content={thinkingContent}
                        isStreaming={isThinkingStreaming}
                        thinkingSeconds={msg.thinkingSeconds}
                        startTime={isThinkingStreaming ? thinkingStartTimeRef.current : null}
                      />
                    )}
                    {msg.role === 'assistant' && msg.toolExecutions && msg.toolExecutions.length > 0 && (
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
                    {msg.role === 'assistant' &&
                      !isStreaming &&
                      responseNeedsContinueAction(mainContent || msg.content) && (
                        <ContinueActionBanner
                          theme={theme}
                          disabled={isLoading}
                          autoContinuing={autoContinuing && isLastVisibleMessage}
                          onContinue={() => {
                            pendingSendContentRef.current = CONTINUE_USER_MESSAGE;
                            void handleSend();
                          }}
                        />
                      )}
                    {isStreaming && thinkingContent === null && (
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
            <div ref={messagesEndRef} aria-hidden="true" />
          </div>
            {showScrollButton && (
              <button
                type="button"
                className={styles.scrollButton}
                onClick={scrollDownPage}
                title="Scroll to bottom of conversation"
                data-testid="scroll-to-bottom-button"
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
