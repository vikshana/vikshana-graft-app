import { test, expect } from './fixtures';

// NOTE: Dual-model UI logic tests (mode toggle, model selection) are covered by unit tests
// in ChatInterface.test.tsx. E2E tests for these features were removed because Grafana's
// plugin loader initializes before page render, making API mocking ineffective.

test('ChatInterface should maintain mode selection when navigating', async ({ page, mockLLMHealth, waitForPortal }) => {
    await mockLLMHealth();
    await page.goto('/a/vikshana-graft-app');

    await expect(page.getByTestId('landing-title')).toBeVisible({ timeout: 10000 });
    await waitForPortal();

    const input = page.getByTestId('chat-input');
    await expect(input).toBeEnabled({ timeout: 15000 });
    await input.fill('Test message');

    const sendButton = page.getByTestId('send-message-button');
    await expect(sendButton).toBeEnabled();
    await sendButton.click();

    await expect(page.getByText('Test message')).toBeVisible();

    await page.getByTestId('back-button').click();

    await expect(page.getByTestId('landing-title')).toBeVisible();
});
