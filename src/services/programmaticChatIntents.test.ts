import {
    canSendChatMessage,
    canSendWithoutLlm,
    chatInputEnabled,
    messageHasProgrammaticHandler,
} from './programmaticChatIntents';

describe('programmaticChatIntents', () => {
    const rename =
        'Rename the dashboard for the 2505-200033 machine to be NewMachine instead of Keysight';
    const panelCopy =
        'Create a new panel on the 2505-200033 dashboard that is the same as the "Pressure" panel on 2210-177097 but with data for 2505-200033';

    it('detects rename prompts', () => {
        expect(messageHasProgrammaticHandler(rename)).toBe(true);
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
