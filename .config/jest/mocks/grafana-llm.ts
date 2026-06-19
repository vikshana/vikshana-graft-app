// Stub for @grafana/llm in jest. The real package pulls in ESM-only transitive
// deps (pkce-challenge via @modelcontextprotocol/sdk) that jest can't load in
// jsdom. Our unit tests exercise OUR code (llm.ts helpers, ChatInterface), not
// the @grafana/llm internals, so a lightweight stub is sufficient. Tests that
// need specific return values can jest.spyOn these members.

export const llm = {
    Model: { LARGE: 'large', BASE: 'base' },
    chatCompletions: () => Promise.resolve({ choices: [{ message: { content: '' } }] }),
    health: () => Promise.resolve({ ok: true, configured: true }),
};

export const mcp = {
    useMCPClient: () => ({ client: null, enabled: false }),
    convertToolsToOpenAI: () => [],
    // Render children directly so the provider is a no-op wrapper in tests.
    MCPClientProvider: ({ children }: { children?: unknown }) => children ?? null,
    streamableHTTP: () => undefined,
};
