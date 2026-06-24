import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatInterface } from './ChatInterface';
import { llmService } from '../../../services/llm';
import { contextService } from '../../../services/context';
import { chatHistoryService } from '../../../services/chatHistory';


// Mock dependencies
jest.mock('../../../services/llm');
jest.mock('../../../services/context');
jest.mock('../../../services/chatHistory');

// Mock @grafana/llm with health API
const mockLlmHealth = jest.fn().mockResolvedValue({
    configured: true,
    ok: true,
    models: {
        base: { ok: true },
        large: { ok: true }
    }
});

jest.mock('@grafana/llm', () => ({
    llm: {
        health: () => mockLlmHealth(),
        enabled: jest.fn().mockResolvedValue(true),
        chatCompletions: jest.fn(),
        Model: { BASE: 'base', LARGE: 'large' }
    },
    mcp: {
        useMCPClient: jest.fn().mockReturnValue({ enabled: false, client: null }),
        convertToolsToOpenAI: jest.fn().mockReturnValue([])
    }
}));

jest.mock('@grafana/runtime', () => ({
    ...jest.requireActual('@grafana/runtime'),
    getBackendSrv: () => ({
        post: jest.fn(),
        get: jest.fn().mockResolvedValue({}),
        fetch: jest.fn().mockReturnValue({
            subscribe: ({ next, complete }: any) => {
                next({ data: { content: 'Mock response' } });
                if (complete) {
                    complete();
                }
                return { unsubscribe: jest.fn() };
            }
        }),
    }),
}));

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

describe('ChatInterface', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Reset LLM health mock to default (configured and healthy)
        mockLlmHealth.mockResolvedValue({
            configured: true,
            ok: true,
            models: {
                base: { ok: true },
                large: { ok: true }
            }
        });
        (contextService.getCurrentDashboard as jest.Mock).mockResolvedValue({});
        (contextService.getUserContext as jest.Mock).mockReturnValue({ login: 'testuser', name: 'Test User' });
        (contextService.getDataSources as jest.Mock).mockReturnValue([]);
        (contextService.getBuildInfo as jest.Mock).mockReturnValue({ version: '11.0.0', dashboardSchema: 'v1' });
        (chatHistoryService.getSession as jest.Mock).mockReturnValue(null);
        (chatHistoryService.saveSession as jest.Mock).mockReturnValue({ id: 'test-session-id', messages: [] });

        // Mock scrollTo and scrollIntoView which are not available in test environment
        Element.prototype.scrollTo = jest.fn();
        Element.prototype.scrollIntoView = jest.fn();

        // Mock FileReader
        class MockFileReader {
            result: string | null = null;
            readAsDataURL() {
                this.result = 'data:text/plain;base64,mockbase64';
                // @ts-ignore
                if (this.onload) {this.onload({ target: { result: this.result } });}
                // @ts-ignore
                if (this.onloadend) {this.onloadend({ target: { result: this.result } });}
            }
            readAsText() {
                this.result = 'mock content';
                // @ts-ignore
                if (this.onload) {this.onload({ target: { result: this.result } });}
                // @ts-ignore
                if (this.onloadend) {this.onloadend({ target: { result: this.result } });}
            }
        }
        // @ts-ignore
        window.FileReader = MockFileReader;
    });

    it('renders the landing page initially', async () => {
        render(
            <MemoryRouter>
                <ChatInterface />
            </MemoryRouter>
        );
        // Wait for the greeting to appear (it might depend on context loading)
        await waitFor(() => {
            expect(screen.getByTestId('landing-title')).toBeInTheDocument();
        });
        expect(screen.getByText('Previous Conversations')).toBeInTheDocument();
    });

    it('switches to chat view when sending a message', async () => {
        (llmService.chat as jest.Mock).mockImplementation(async (messages, context, onUpdate) => {
            onUpdate('Hello there!');
        });

        render(
            <MemoryRouter>
                <ChatInterface />
            </MemoryRouter>
        );

        // Wait for LLM health check to complete and send button to be enabled
        await waitFor(() => {
            expect(screen.getByTestId('send-message-button')).not.toBeDisabled();
        });

        const input = screen.getByTestId('chat-input');
        fireEvent.change(input, { target: { value: 'Hello' } });

        const sendButton = screen.getByLabelText('Send message');
        await act(async () => {
            fireEvent.click(sendButton);
        });

        // Wait for assistant response to appear (which means user message was sent)
        await waitFor(() => {
            expect(screen.getByText('Hello there!')).toBeInTheDocument();
        });

        // Landing page title should be gone
        expect(screen.queryByTestId('landing-title')).not.toBeInTheDocument();
    });

    it('passes selected model type to llmService', async () => {
        (llmService.chat as jest.Mock).mockImplementation(async (messages, context, onUpdate) => {
            onUpdate('Response');
        });

        render(
            <MemoryRouter>
                <ChatInterface />
            </MemoryRouter>
        );

        // Wait for LLM health check to complete and send button to be enabled
        await waitFor(() => {
            expect(screen.getByTestId('send-message-button')).not.toBeDisabled();
        });

        // Switch to Deep Research using testid
        const deepResearchBtn = screen.getByTestId('mode-button-deep-research');
        await act(async () => {
            fireEvent.click(deepResearchBtn);
        });

        // Verify the mode switched
        await waitFor(() => {
            expect(deepResearchBtn).toHaveAttribute('aria-pressed', 'true');
        });

        // Send message
        const input = screen.getByTestId('chat-input');
        fireEvent.change(input, { target: { value: 'test message' } });

        // Find and click send button
        const sendButton = screen.getByLabelText('Send message');
        await act(async () => {
            fireEvent.click(sendButton);
        });

        await waitFor(() => {
            expect(llmService.chat).toHaveBeenCalled();
            const calls = (llmService.chat as jest.Mock).mock.calls;
            const lastCall = calls[calls.length - 1];
            // 4th argument (index 3) is modelType
            expect(lastCall[3]).toBe('thinking');
        });
    });

    it('displays assistant response', async () => {
        (llmService.chat as jest.Mock).mockImplementation(async (messages, context, onUpdate) => {
            onUpdate('I am Graft.');
        });

        render(
            <MemoryRouter>
                <ChatInterface />
            </MemoryRouter>
        );

        // Wait for LLM health check to complete
        await waitFor(() => {
            expect(screen.getByTestId('send-message-button')).not.toBeDisabled();
        });

        const input = screen.getByTestId('chat-input');
        fireEvent.change(input, { target: { value: 'Who are you?' } });

        const sendButton = screen.getByLabelText('Send message');
        fireEvent.click(sendButton);

        await waitFor(() => {
            expect(screen.getByText('I am Graft.')).toBeInTheDocument();
        });

        // Also verify user message is there
        expect(screen.getByText('Who are you?')).toBeInTheDocument();
    });

    it('handles multiple file attachments', async () => {
        render(
            <MemoryRouter>
                <ChatInterface />
            </MemoryRouter>
        );

        // Wait for settings to load so that image support is enabled
        await waitFor(() => {
            expect(screen.getByTestId('mode-button-standard')).not.toBeDisabled();
        });

        const file1 = new File(['content1'], 'test1.txt', { type: 'text/plain' });
        const file2 = new File(['content2'], 'test2.png', { type: 'image/png' });

        const input = screen.getByTestId('landing-file-input');

        fireEvent.change(input, { target: { files: [file1, file2] } });

        await waitFor(() => {
            expect(screen.getByText('test1.txt')).toBeInTheDocument();
            expect(screen.getByText('test2.png')).toBeInTheDocument();
        });
    });

    it('removes attached files', async () => {
        render(
            <MemoryRouter>
                <ChatInterface />
            </MemoryRouter>
        );

        const file = new File(['content'], 'test.txt', { type: 'text/plain' });
        const input = screen.getByTestId('landing-file-input');

        // Mock FileReader
        const mockFileReader = {
            readAsText: jest.fn(),
            result: 'content',
            onloadend: () => { },
        };
        // @ts-ignore
        window.FileReader = jest.fn(() => mockFileReader);

        fireEvent.change(input, { target: { files: [file] } });
        // @ts-ignore
        mockFileReader.onloadend();

        await waitFor(() => {
            expect(screen.getByText('test.txt')).toBeInTheDocument();
        });

        // The remove button has an icon but no text, might need a better selector or aria-label
        // Actually, let's find it by the icon or class if possible, or add aria-label in the component.
        // For now, let's assume it's the button inside the preview.
        // We can find it by looking for the button that contains the 'times' icon.
        // Since we mocked Icon, we can look for the times icon.
        // But wait, Icon is from @grafana/ui.
        // Let's just click the button that is present in the preview.

        const closeButton = screen.getByTestId('remove-file-button');
        fireEvent.click(closeButton);

        await waitFor(() => {
            expect(screen.queryByText('test.txt')).not.toBeInTheDocument();
        });
    });

    it('scrolls to bottom on new message', async () => {
        const scrollIntoViewMock = jest.fn();
        Element.prototype.scrollIntoView = scrollIntoViewMock;

        (llmService.chat as jest.Mock).mockImplementation(async (messages, context, onUpdate) => {
            onUpdate('Response');
        });

        render(
            <MemoryRouter>
                <ChatInterface />
            </MemoryRouter>
        );

        // Wait for LLM health check to complete
        await waitFor(() => {
            expect(screen.getByTestId('send-message-button')).not.toBeDisabled();
        });

        const input = screen.getByTestId('chat-input');
        fireEvent.change(input, { target: { value: 'Message' } });
        fireEvent.click(screen.getByLabelText('Send message'));

        await waitFor(() => {
            expect(scrollIntoViewMock).toHaveBeenCalled();
        });
    });

    describe('Thinking Block', () => {
        // Renders the component and waits for the initial async health check to complete.
        const renderComponent = async () => {
            await act(async () => {
                render(
                    <MemoryRouter>
                        <ChatInterface />
                    </MemoryRouter>
                );
            });
        };

        // Helper to wait for LLM health check and send a message
        const sendMessage = async (message: string) => {
            await waitFor(() => {
                expect(screen.getByTestId('send-message-button')).not.toBeDisabled();
            });
            const input = screen.getByTestId('chat-input');
            fireEvent.change(input, { target: { value: message } });
            await act(async () => {
                fireEvent.click(screen.getByLabelText('Send message'));
            });
        };

        it('renders thinking block when response starts with <think>', async () => {
            (llmService.chat as jest.Mock).mockImplementation(async (messages, context, onUpdate) => {
                onUpdate('<think>Processing your request...</think>Here is the answer');
            });

            await renderComponent();

            await sendMessage('Test');

            await waitFor(() => {
                expect(screen.getByText(/Thought for \d+s/)).toBeInTheDocument();
            });

            expect(screen.getByText('Here is the answer')).toBeInTheDocument();
        });

        it('correctly parses complete thinking block', async () => {
            (llmService.chat as jest.Mock).mockImplementation(async (messages, context, onUpdate) => {
                onUpdate('<think>Reasoning process</think>Final answer');
            });

            await renderComponent();

            await sendMessage('Test');

            await waitFor(() => {
                expect(screen.getByText(/Thought for \d+s/)).toBeInTheDocument();
            });

            expect(screen.getByText('Final answer')).toBeInTheDocument();
        });

        it('handles streaming thinking block without closing tag', async () => {
            (llmService.chat as jest.Mock).mockImplementation(async (messages, context, onUpdate) => {
                onUpdate('<think>Still thinking...');
                // Use real setTimeout for the test, not the mocked one
                await new Promise((resolve) => {
                    const realSetTimeout = setTimeout;
                    realSetTimeout(() => {
                        onUpdate('<think>Still thinking...</think>Done!');
                        resolve(undefined);
                    }, 100);
                });
            });

            await renderComponent();

            await sendMessage('Test');

            await waitFor(() => {
                expect(screen.queryByText(/Thinking for \d+s/)).toBeInTheDocument();
            }, { timeout: 3000 });

            await waitFor(() => {
                expect(screen.getByText(/Thought for \d+s/)).toBeInTheDocument();
                expect(screen.getByText('Done!')).toBeInTheDocument();
            }, { timeout: 3000 });
        });

        it('timer increments during streaming thinking', async () => {
            (llmService.chat as jest.Mock).mockImplementation(async (messages, context, onUpdate) => {
                onUpdate('<think>Processing...');
                await new Promise((resolve) => {
                    const realSetTimeout = setTimeout;
                    realSetTimeout(() => {
                        onUpdate('<think>Processing...</think>Complete');
                        resolve(undefined);
                    }, 3000);
                });
            });

            await renderComponent();

            await sendMessage('Test');

            await waitFor(() => {
                expect(screen.queryByText('Thinking for 0s')).toBeInTheDocument();
            }, { timeout: 3000 });

            await waitFor(() => {
                expect(screen.getByText(/Thought for \d+s/)).toBeInTheDocument();
            }, { timeout: 5000 });
        });

        it('allows expanding and collapsing thinking content', async () => {
            (llmService.chat as jest.Mock).mockImplementation(async (messages, context, onUpdate) => {
                onUpdate('<think>Internal reasoning here</think>Final response');
            });

            await renderComponent();

            await sendMessage('Test');

            const thinkingHeader = await screen.findByText(/Thought for \d+s/);

            expect(screen.queryByText('Internal reasoning here')).not.toBeInTheDocument();

            fireEvent.click(thinkingHeader);

            await waitFor(() => {
                expect(screen.getByText('Internal reasoning here')).toBeInTheDocument();
            });

            fireEvent.click(thinkingHeader);

            await waitFor(() => {
                expect(screen.queryByText('Internal reasoning here')).not.toBeInTheDocument();
            });
        });


        it('displays "Thinking for" label instead of "Thinking" during streaming', async () => {
            (llmService.chat as jest.Mock).mockImplementation(async (messages, context, onUpdate) => {
                onUpdate('<think>Processing...');
                await new Promise((resolve) => {
                    const realSetTimeout = setTimeout;
                    realSetTimeout(() => {
                        onUpdate('<think>Processing...</think>Complete');
                        resolve(undefined);
                    }, 1500);
                });
            });

            await renderComponent();

            await sendMessage('Test');

            await waitFor(() => {
                expect(screen.queryByText(/Thinking for \d+s/)).toBeInTheDocument();
            }, { timeout: 3000 });
        });

        it('stores thinking duration in message object', async () => {
            (llmService.chat as jest.Mock).mockImplementation(async (messages, context, onUpdate) => {
                onUpdate('<think>Reasoning...');
                await new Promise((resolve) => {
                    const realSetTimeout = setTimeout;
                    realSetTimeout(() => {
                        onUpdate('<think>Reasoning...</think>Answer');
                        resolve(undefined);
                    }, 1000);
                });
            });

            await renderComponent();

            await sendMessage('Test');

            await waitFor(() => {
                expect(screen.getByText(/Thought for \d+s/)).toBeInTheDocument();
            }, { timeout: 3000 });

            // Verify that chatHistoryService.saveSession was called
            // and that the saved message includes thinkingSeconds
            await waitFor(() => {
                expect(chatHistoryService.saveSession).toHaveBeenCalled();
                const savedMessages = (chatHistoryService.saveSession as jest.Mock).mock.calls[0][0];
                const assistantMessage = savedMessages.find((m: any) => m.role === 'assistant');
                expect(assistantMessage).toBeDefined();
                expect(assistantMessage.thinkingSeconds).toBeDefined();
                expect(assistantMessage.thinkingSeconds).toBeGreaterThanOrEqual(0);
            });
        });

        it('displays persisted thinking duration when loading from history', async () => {
            // Mock a session with a stored thinking duration
            const mockSession = {
                id: 'test-session-123',
                messages: [
                    { role: 'user', content: 'Test question' },
                    {
                        role: 'assistant',
                        content: '<think>Reasoning process</think>Final answer',
                        thinkingSeconds: 5
                    }
                ],
                timestamp: Date.now()
            };

            (chatHistoryService.getSession as jest.Mock).mockReturnValue(mockSession);

            await act(async () => {
                render(
                    <MemoryRouter initialEntries={['/?session=test-session-123']}>
                        <ChatInterface />
                    </MemoryRouter>
                );
            });

            // The thinking block should show the persisted duration (5 seconds), not 0
            await waitFor(() => {
                expect(screen.getByText('Thought for 5s')).toBeInTheDocument();
            });

            expect(screen.getByText('Final answer')).toBeInTheDocument();
        });

        it('handles messages without thinking blocks', async () => {
            (llmService.chat as jest.Mock).mockImplementation(async (messages, context, onUpdate) => {
                onUpdate('Regular response without thinking');
            });

            await renderComponent();

            await sendMessage('Test');

            await waitFor(() => {
                expect(screen.getByText('Regular response without thinking')).toBeInTheDocument();
            });

            // Verify no thinking block appears
            expect(screen.queryByText(/Thinking/)).not.toBeInTheDocument();
            expect(screen.queryByText(/Thought/)).not.toBeInTheDocument();
        });
    });

    it('defaults to Standard mode when both models are enabled', async () => {
        render(
            <MemoryRouter>
                <ChatInterface />
            </MemoryRouter>
        );

        await waitFor(() => {
            expect(screen.getByTestId('mode-button-standard')).toHaveAttribute('aria-pressed', 'true');
            expect(screen.getByTestId('mode-button-deep-research')).toHaveAttribute('aria-pressed', 'false');
            expect(screen.getByTestId('mode-button-deep-research')).not.toBeDisabled();
        });
    });

    describe('LLM Plugin Not Configured', () => {
        it('shows warning banner when LLM plugin is not configured', async () => {
            mockLlmHealth.mockResolvedValue({
                configured: false,
                ok: false,
                models: {}
            });

            await act(async () => {
                render(
                    <MemoryRouter>
                        <ChatInterface />
                    </MemoryRouter>
                );
            });

            await waitFor(() => {
                expect(screen.getByText(/LLM Plugin Not Configured/i)).toBeInTheDocument();
            });
        });

        it('shows link to LLM plugin configuration when not configured', async () => {
            mockLlmHealth.mockResolvedValue({
                configured: false,
                ok: false,
                models: {}
            });

            await act(async () => {
                render(
                    <MemoryRouter>
                        <ChatInterface />
                    </MemoryRouter>
                );
            });

            await waitFor(() => {
                const link = screen.getByRole('link', { name: /configure the llm plugin/i });
                expect(link).toHaveAttribute('href', '/plugins/grafana-llm-app');
            });
        });

        it('disables send button when LLM plugin is not configured', async () => {
            mockLlmHealth.mockResolvedValue({
                configured: false,
                ok: false,
                models: {}
            });

            await act(async () => {
                render(
                    <MemoryRouter>
                        <ChatInterface />
                    </MemoryRouter>
                );
            });

            await waitFor(() => {
                expect(screen.getByTestId('send-message-button')).toBeDisabled();
            });
        });

        it('disables model toggle buttons when LLM plugin is not configured', async () => {
            mockLlmHealth.mockResolvedValue({
                configured: false,
                ok: false,
                models: {}
            });

            await act(async () => {
                render(
                    <MemoryRouter>
                        <ChatInterface />
                    </MemoryRouter>
                );
            });

            await waitFor(() => {
                expect(screen.getByTestId('mode-button-standard')).toBeDisabled();
                expect(screen.getByTestId('mode-button-deep-research')).toBeDisabled();
            });
        });

        it('disables chat input when LLM plugin is not configured', async () => {
            mockLlmHealth.mockResolvedValue({
                configured: false,
                ok: false,
                models: {}
            });

            await act(async () => {
                render(
                    <MemoryRouter>
                        <ChatInterface />
                    </MemoryRouter>
                );
            });

            await waitFor(() => {
                expect(screen.getByTestId('chat-input')).toBeDisabled();
            });
        });

        it('shows error banner when LLM plugin is configured but unhealthy', async () => {
            mockLlmHealth.mockResolvedValue({
                configured: true,
                ok: false,
                error: 'Connection failed',
                models: {}
            });

            await act(async () => {
                render(
                    <MemoryRouter>
                        <ChatInterface />
                    </MemoryRouter>
                );
            });

            await waitFor(() => {
                expect(screen.getByText(/LLM Plugin Unavailable/i)).toBeInTheDocument();
            });
        });
    });

    describe('Settings gear icon', () => {
        it('renders the settings button on the landing page', async () => {
            render(
                <MemoryRouter>
                    <ChatInterface />
                </MemoryRouter>
            );

            await waitFor(() => {
                expect(screen.getByTestId('landing-title')).toBeInTheDocument();
            });

            expect(screen.getByTestId('settings-button')).toBeInTheDocument();
        });

        it('settings button has the correct title attribute', async () => {
            render(
                <MemoryRouter>
                    <ChatInterface />
                </MemoryRouter>
            );

            await waitFor(() => {
                expect(screen.getByTestId('settings-button')).toBeInTheDocument();
            });

            expect(screen.getByTestId('settings-button')).toHaveAttribute('title', 'Plugin configuration');
        });

        it('navigates to the plugin config page when settings button is clicked', async () => {
            const originalLocation = window.location;
            // jsdom does not support navigation, so we replace href with a writable mock
            delete (window as any).location;
            (window as any).location = { href: '' };

            try {
                render(
                    <MemoryRouter>
                        <ChatInterface />
                    </MemoryRouter>
                );

                await waitFor(() => {
                    expect(screen.getByTestId('settings-button')).toBeInTheDocument();
                });

                fireEvent.click(screen.getByTestId('settings-button'));

                expect(window.location.href).toBe('/plugins/vikshana-graft-app?page=configuration');
            } finally {
                // Always restore original location, even if an assertion throws
                (window as any).location = originalLocation;
            }
        });

        it('settings button is not shown in active chat view', async () => {
            (llmService.chat as jest.Mock).mockImplementation(async (messages, context, onUpdate) => {
                onUpdate('Hello there!');
            });

            render(
                <MemoryRouter>
                    <ChatInterface />
                </MemoryRouter>
            );

            await waitFor(() => {
                expect(screen.getByTestId('send-message-button')).not.toBeDisabled();
            });

            const input = screen.getByTestId('chat-input');
            fireEvent.change(input, { target: { value: 'Hello' } });

            await act(async () => {
                fireEvent.click(screen.getByLabelText('Send message'));
            });

            await waitFor(() => {
                expect(screen.getByText('Hello there!')).toBeInTheDocument();
            });

            // Landing page (and its settings button) should be gone
            expect(screen.queryByTestId('settings-button')).not.toBeInTheDocument();
        });
    });

    describe('panel context (modal mode)', () => {
        const mockPanelContext = {
            pluginId: 'timeseries',
            id: 42,
            title: 'CPU Usage',
            timeRange: { from: 'now-1h', to: 'now' },
            timeZone: 'browser',
            dashboard: { uid: 'dash-uid-1', title: 'My Dashboard', tags: [] },
            targets: [{ refId: 'A', datasource: { uid: 'prom-uid', type: 'prometheus' } }],
        } as any;

        it('pre-fills the input with panel context on mount', async () => {
            render(
                <MemoryRouter>
                    <ChatInterface panelContext={mockPanelContext} />
                </MemoryRouter>
            );

            await waitFor(() => {
                const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
                expect(input.value).toContain('CPU Usage');
                expect(input.value).toContain('My Dashboard');
                expect(input.value).toContain('now-1h');
                expect(input.value).toContain('prom-uid');
            });
        });

        it('renders the modal header with panel title and "Open in Graft" button', async () => {
            render(
                <MemoryRouter>
                    <ChatInterface panelContext={mockPanelContext} />
                </MemoryRouter>
            );

            await waitFor(() => {
                expect(screen.getByTestId('modal-header')).toBeInTheDocument();
                expect(screen.getByTestId('modal-header-title')).toHaveTextContent('CPU Usage');
                expect(screen.getByTestId('open-in-graft-button')).toBeInTheDocument();
            });
        });

        it('does not render a separate Close button (Grafana modal × handles dismiss)', async () => {
            const onDismiss = jest.fn();
            render(
                <MemoryRouter>
                    <ChatInterface panelContext={mockPanelContext} onDismiss={onDismiss} />
                </MemoryRouter>
            );

            await waitFor(() => {
                expect(screen.getByTestId('modal-header')).toBeInTheDocument();
            });

            // No separate Close button — Grafana's × button handles dismiss
            expect(screen.queryByTestId('modal-close-button')).not.toBeInTheDocument();
        });

        it('does not render modal header when panelContext is absent', async () => {
            render(
                <MemoryRouter>
                    <ChatInterface />
                </MemoryRouter>
            );

            await waitFor(() => {
                expect(screen.getByTestId('landing-title')).toBeInTheDocument();
            });

            expect(screen.queryByTestId('modal-header')).not.toBeInTheDocument();
        });

        it('"Open in Graft" opens new tab with session when messages exist', async () => {
            const windowOpenSpy = jest.spyOn(window, 'open').mockImplementation(() => null);
            (chatHistoryService.saveSession as jest.Mock).mockReturnValue({
                id: 'saved-session-123',
                messages: [],
            });
            (llmService.chat as jest.Mock).mockImplementation(async (_msgs: any, _ctx: any, onUpdate: any) => {
                onUpdate('Response from Graft');
            });

            render(
                <MemoryRouter>
                    <ChatInterface panelContext={mockPanelContext} />
                </MemoryRouter>
            );

            // Send a message so messages.length > 0
            await waitFor(() => {
                expect(screen.getByTestId('chat-input')).toBeInTheDocument();
            });

            const sendBtn = screen.getByLabelText('Send message');
            await act(async () => { fireEvent.click(sendBtn); });

            await waitFor(() => {
                expect(screen.getByText('Response from Graft')).toBeInTheDocument();
            });

            // Now click "Open in Graft"
            await act(async () => {
                fireEvent.click(screen.getByTestId('open-in-graft-button'));
            });

            expect(chatHistoryService.saveSession).toHaveBeenCalled();
            expect(windowOpenSpy).toHaveBeenCalledWith(
                expect.stringContaining('session=saved-session-123'),
                '_blank'
            );

            windowOpenSpy.mockRestore();
        });

        it('"Open in Graft" opens new tab with panel URL params when no messages', async () => {
            const windowOpenSpy = jest.spyOn(window, 'open').mockImplementation(() => null);

            render(
                <MemoryRouter>
                    <ChatInterface panelContext={mockPanelContext} />
                </MemoryRouter>
            );

            await waitFor(() => {
                expect(screen.getByTestId('open-in-graft-button')).toBeInTheDocument();
            });

            // No messages sent — click "Open in Graft" immediately
            await act(async () => {
                fireEvent.click(screen.getByTestId('open-in-graft-button'));
            });

            expect(chatHistoryService.saveSession).not.toHaveBeenCalled();
            expect(windowOpenSpy).toHaveBeenCalledWith(
                expect.stringContaining('panelTitle=CPU+Usage'),
                '_blank'
            );

            windowOpenSpy.mockRestore();
        });
    });

    describe('Explore URL param pre-fill', () => {
        it('pre-fills input from dsUid + queries + time range params', async () => {
            const queries = JSON.stringify([{ refId: 'A', expr: 'up{job="prometheus"}' }]);
            render(
                <MemoryRouter
                    initialEntries={[`/?dsUid=prom-uid&dsType=prometheus&from=now-6h&to=now&queries=${encodeURIComponent(queries)}`]}
                >
                    <ChatInterface />
                </MemoryRouter>
            );

            await waitFor(() => {
                const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
                expect(input.value).toContain('prom-uid');
                expect(input.value).toContain('up{job="prometheus"}');
                expect(input.value).toContain('now-6h');
            });
        });

        it('does not pre-fill when no dsUid or queries params present', async () => {
            render(
                <MemoryRouter initialEntries={['/']}>
                    <ChatInterface />
                </MemoryRouter>
            );

            await waitFor(() => {
                expect(screen.getByTestId('landing-title')).toBeInTheDocument();
            });

            const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
            expect(input.value).toBe('');
        });
    });

    describe('panel URL param pre-fill (Open in Graft zero-message path)', () => {
        it('pre-fills input from panelTitle URL params', async () => {
            render(
                <MemoryRouter
                    initialEntries={['/?panelTitle=CPU+Usage&dashboardTitle=My+Dashboard&from=now-3h&to=now&dsUid=prom-uid']}
                >
                    <ChatInterface />
                </MemoryRouter>
            );

            await waitFor(() => {
                const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
                expect(input.value).toContain('CPU Usage');
                expect(input.value).toContain('My Dashboard');
                expect(input.value).toContain('now-3h');
                expect(input.value).toContain('prom-uid');
            });
        });
    });
});
