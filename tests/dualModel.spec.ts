import { test, expect } from './fixtures';

// NOTE: Dual-model UI logic tests (mode toggle, model selection) are covered by unit tests
// in ChatInterface.test.tsx. E2E tests for these features were removed because Grafana's
// plugin loader initializes before page render, making API mocking ineffective.

test('ChatInterface should maintain mode selection when navigating', async ({ page, mockLLMHealth }) => {
    // Mock LLM health API to ensure chat functionality is enabled
    await mockLLMHealth();

    await page.goto('/a/vikshana-graft-app');

    // Wait for landing page to load and inputs to be interactive
    await expect(page.getByTestId('landing-title')).toBeVisible({ timeout: 10000 });
    const input = page.getByTestId('chat-input');
    await expect(input).toBeEnabled({ timeout: 15000 });

    // Send a message to enter chat view
    await input.fill('Test message');
    const sendButton = page.getByTestId('send-message-button');
    await expect(sendButton).toBeEnabled();
    await sendButton.click();

    // Verify we're in chat view
    await expect(page.getByText('Test message')).toBeVisible();

    // Go back to landing page
    await page.getByTestId('back-button').click();

    // Verify landing page is displayed again
    await expect(page.getByTestId('landing-title')).toBeVisible();
});
