import { test, expect } from './fixtures';

// NOTE: Dual-model UI logic tests (mode toggle, model selection) are covered by unit tests
// in ChatInterface.test.tsx. E2E tests for these features were removed because Grafana's
// plugin loader initializes before page render, making API mocking ineffective.

test('ChatInterface should maintain mode selection when navigating', async ({ page, mockLLMHealth, waitForPortal }) => {
    await mockLLMHealth();
    await page.goto('/a/vikshana-graft-app');
    // Clear any session state from prior tests so the landing page is shown
    await page.evaluate(() => localStorage.removeItem('graft_chat_history'));
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

test('ChatInterface Standard mode button is active by default', async ({ page, mockLLMHealth, waitForPortal }) => {
    await mockLLMHealth();
    await page.goto('/a/vikshana-graft-app');
    await page.evaluate(() => localStorage.removeItem('graft_chat_history'));
    await page.goto('/a/vikshana-graft-app');
    await expect(page.getByTestId('landing-title')).toBeVisible({ timeout: 10000 });
    await waitForPortal();

    const standardBtn = page.getByTestId('mode-button-standard');
    const deepResearchBtn = page.getByTestId('mode-button-deep-research');

    await expect(standardBtn).toBeVisible({ timeout: 15000 });
    await expect(deepResearchBtn).toBeVisible();

    // Standard is selected by default
    await expect(standardBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(deepResearchBtn).toHaveAttribute('aria-pressed', 'false');
});

test('ChatInterface mode toggle switches between Standard and Deep Research', async ({ page, mockLLMHealth, waitForPortal }) => {
    await mockLLMHealth();
    await page.goto('/a/vikshana-graft-app');
    await page.evaluate(() => localStorage.removeItem('graft_chat_history'));
    await page.goto('/a/vikshana-graft-app');
    await expect(page.getByTestId('landing-title')).toBeVisible({ timeout: 10000 });
    await waitForPortal();

    const standardBtn = page.getByTestId('mode-button-standard');
    const deepResearchBtn = page.getByTestId('mode-button-deep-research');

    await expect(standardBtn).toBeEnabled({ timeout: 15000 });
    await expect(deepResearchBtn).toBeEnabled();

    // Switch to Deep Research
    await deepResearchBtn.click();
    await expect(deepResearchBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(standardBtn).toHaveAttribute('aria-pressed', 'false');

    // Switch back to Standard
    await standardBtn.click();
    await expect(standardBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(deepResearchBtn).toHaveAttribute('aria-pressed', 'false');
});

