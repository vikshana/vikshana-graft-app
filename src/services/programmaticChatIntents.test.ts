import {
    canSendChatMessage,
    canSendWithoutLlm,
    chatInputEnabled,
    isSimpleConversationalMessage,
    messageHasProgrammaticHandler,
} from './programmaticChatIntents';

describe('programmaticChatIntents', () => {
    const rename =
        'Rename the dashboard for the 2505-200033 machine to be NewMachine instead of Keysight';
    const panelCopy =
        'Create a new panel on the 2505-200033 dashboard that is the same as the "Pressure" panel on 2210-177097 but with data for 2505-200033';
    const panelRename =
        'Rename the "Pressure Gauge" panel to "System Pressure" on dashboard UID = cfo0wckufbdhce.';

    it('detects rename prompts', () => {
        expect(messageHasProgrammaticHandler(rename)).toBe(true);
    });

    it('detects panel rename prompts', () => {
        expect(messageHasProgrammaticHandler(panelRename)).toBe(true);
        expect(canSendWithoutLlm(panelRename, true)).toBe(true);
    });

    it('detects single panel copy prompts', () => {
        expect(messageHasProgrammaticHandler(panelCopy)).toBe(true);
        expect(canSendWithoutLlm(panelCopy, true)).toBe(true);
    });

    it('allows send without LLM when MCP is connected', () => {
        expect(canSendWithoutLlm(rename, true)).toBe(true);
        expect(canSendWithoutLlm(rename, false)).toBe(false);
        expect(canSendWithoutLlm('What is the weather?', true)).toBe(false);
    });

    it('enables input when MCP is connected even if LLM is not ready', () => {
        expect(chatInputEnabled(false, true)).toBe(true);
        expect(chatInputEnabled(false, false)).toBe(false);
    });

    it('detects simple conversational messages', () => {
        expect(isSimpleConversationalMessage('test')).toBe(true);
        expect(isSimpleConversationalMessage('hello')).toBe(true);
        expect(isSimpleConversationalMessage('rename dashboard')).toBe(false);
        expect(isSimpleConversationalMessage(rename)).toBe(false);
    });

    it('routes plural Grafana-noun queries to the tool path (not simple chat)', () => {
        // Regression: plural forms previously slipped past \bdashboard\b and were
        // misrouted to the tool-less conversational path → "I have no access" replies.
        expect(isSimpleConversationalMessage('What dashboards are in this organization?')).toBe(false);
        expect(isSimpleConversationalMessage('List the dashboards in this organization.')).toBe(false);
        expect(isSimpleConversationalMessage('Search dashboards and show their titles and uids.')).toBe(false);
        expect(isSimpleConversationalMessage('Show me the metrics available.')).toBe(false);
        expect(isSimpleConversationalMessage('What folders exist?')).toBe(false);
        expect(isSimpleConversationalMessage('List my datasources.')).toBe(false);
    });

    it('allows send for programmatic prompts without LLM', () => {
        expect(
            canSendChatMessage({
                input: rename,
                isLoading: false,
                llmReady: false,
                mcpConnected: true,
            })
        ).toBe(true);
    });
});
