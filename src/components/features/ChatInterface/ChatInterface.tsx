import React, { useState, useEffect, useRef } from 'react';
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
import { Alert, Button, TextArea, useStyles2, useTheme2, Icon, ConfirmModal } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { mcp } from '@grafana/llm';

// Local services
import { llmService } from '../../../services/llm';
import type { Message, ToolExecution } from '../../../types/llm.types';
import { contextService, UserContext, DataSourceContext, DashboardContext } from '../../../services/context';
import { chatHistoryService } from '../../../services/chatHistory';

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
  let contextStr = '';

  if (user && user.login) {
    contextStr += `User: \n-Name: ${user.name || 'Unknown'} \n-Email: ${user.email || 'Unknown'} \n-Role: ${user.orgRole || 'Unknown'} \n\n`;
  }

  if (dashboard.uid) {
    contextStr += `Current Dashboard: \n-Title: ${dashboard.title} \n-UID: ${dashboard.uid} \n\n`;
  }

  if (dataSources && dataSources.length > 0) {
    contextStr += `Available Data Sources: \n`;
    dataSources.forEach(ds => {
      contextStr += `-${ds.name} (Type: ${ds.type}, UID: ${ds.uid}) \n`;
    });
    contextStr += '\n';
  }

  return contextStr;
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
        const tools = mcp.convertToolsToOpenAI(response.tools);
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

  // Sync state with URL and load session if specified
  useEffect(() => {
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

      const context = formatContext(dashboard, user, dataSources);

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

      await llmService.chat(newMessages, context, (fullContent, toolExecutions) => {
        // Capture the latest values for saving after completion
        finalContent = fullContent;
        finalToolExecutions = toolExecutions || [];
        // Track thinking block timing
        const trimmedContent = fullContent.trimStart();
        if (trimmedContent.startsWith('<think>') && thinkingStartTimeRef.current === null) {
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
            thinkingSeconds: thinkingDuration,
            toolExecutions: toolExecutions
          };
          return updated;
        });
      }, modelType, controller.signal, mcpClient, mcpTools);

      // Save chat to history after completion
      // Construct the final assistant message from the data we tracked during streaming
      const finalAssistantMessage: Message = {
        role: 'assistant',
        content: finalContent,
        thinkingSeconds: thinkingDuration,
        toolExecutions: finalToolExecutions.length > 0 ? finalToolExecutions : undefined
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
      {messages.length === 0 ? (
        <div className={styles.landingContainer}>
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
