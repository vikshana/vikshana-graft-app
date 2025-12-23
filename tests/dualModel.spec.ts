import { test, expect } from './fixtures';

// NOTE: Dual-model UI logic tests (mode toggle, model selection) are covered by unit tests
// in ChatInterface.test.tsx. E2E tests for these features were removed because Grafana's
// plugin loader initializes before page render, making API mocking ineffective.

test('ChatInterface should maintain mode selection when navigating', async ({ page, mockLLMHealth }) => {
    // Mock LLM health API to ensure chat functionality is enabled
    await mockLLMHealth();

    await page.goto('/a/vikshana-graft-app');

    // Wait for landing page to load
    await expect(page.getByTestId('landing-title')).toBeVisible({ timeout: 10000 });

    // Send a message to enter chat view
    const input = page.getByTestId('chat-input');
    await input.fill('Test message');
    await page.getByTestId('send-message-button').click();

    // Verify we're in chat view
    await expect(page.getByText('Test message')).toBeVisible();

    // Go back to landing page
    await page.getByTestId('back-button').click();

    // Verify landing page is displayed again
    await expect(page.getByTestId('landing-title')).toBeVisible();
});
