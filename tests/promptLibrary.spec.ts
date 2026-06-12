import { test, expect } from './fixtures';

test.describe('Prompt Library', () => {
    test('should navigate to prompt library and select a pre-configured prompt', async ({ page, mockLLMHealth }) => {
        // Mock LLM health so chat-input is enabled when we return from the prompt library
        await mockLLMHealth();

        // Go to landing page
        await page.goto('/a/vikshana-graft-app');

        // Wait for the landing page to fully render before clicking
        await expect(page.getByTestId('landing-title')).toBeVisible({ timeout: 15000 });

        // Click Prompt Library link - use force to bypass Grafana 13 portal overlay
        await page.getByTestId('prompt-library-link').click({ force: true });
        await expect(page).toHaveURL(/.*\/prompts/);

        // Check for pre-configured prompts tab
        await expect(page.getByText('Pre-configured Prompts')).toBeVisible();

        // Wait for prompts to load and select the first available pre-configured prompt
        const promptItem = page.getByTestId('pre-configured-prompt-item').first();
        await expect(promptItem).toBeVisible({ timeout: 10000 });

        // Get the prompt content text before clicking
        const promptContent = await promptItem.locator('[data-testid="prompt-content"]').textContent()
            ?? await promptItem.textContent() ?? '';
        // use force to bypass Grafana 13 portal overlay
        await promptItem.click({ force: true });

        // Should navigate back to chat interface (base URL without /prompts)
        await expect(page).toHaveURL(/\/a\/vikshana-graft-app$/);

        // Wait for chat-input to be enabled, then check it's populated
        const input = page.getByTestId('chat-input');
        await expect(input).toBeEnabled({ timeout: 15000 });

        // The input should have some value after selecting a prompt
        await expect(input).not.toHaveValue('');
    });

    test('should create, pin, and delete a user prompt', async ({ page }) => {
        await page.goto('/a/vikshana-graft-app/prompts');

        // Wait for prompts page to load
        await expect(page.getByText('Pre-configured Prompts')).toBeVisible({ timeout: 15000 });

        // Switch to My Prompts - use force to bypass Grafana 13 portal overlay
        await page.getByText('My Prompts').click({ force: true });

        // Wait for "Create New Prompt" button and click - use force to bypass overlay issues
        const createButton = page.getByRole('button', { name: 'Create New Prompt' });
        await expect(createButton).toBeVisible();
        await createButton.click({ force: true });
        await page.getByPlaceholder('e.g., Debug K8s Pods').fill('E2E Test Prompt');
        await page.getByPlaceholder('Enter your prompt here...').fill('E2E Content');
        await page.getByRole('button', { name: 'Save' }).click({ force: true });

        // Verify it appears
        await expect(page.getByText('E2E Test Prompt')).toBeVisible();

        // Pin it - use force to bypass Grafana 13 portal overlay
        const card = page.getByTestId('user-prompt-card').filter({ hasText: 'E2E Test Prompt' });
        await card.locator('button').first().click({ force: true });

        // Delete it - use force to bypass Grafana 13 portal overlay
        await card.locator('button').last().click({ force: true });
        // Wait for confirm modal and click Delete button - scoped to dialog for cross-version compatibility
        const modal = page.locator('[role="dialog"]');
        await expect(modal).toBeVisible();
        await modal.getByRole('button', { name: 'Delete' }).click({ force: true });

        // Verify it's gone
        await expect(page.getByText('E2E Test Prompt')).not.toBeVisible();
    });

    test('should pin a pre-configured prompt', async ({ page }) => {
        await page.goto('/a/vikshana-graft-app/prompts');

        // Wait for prompts page to load
        await expect(page.getByText('Pre-configured Prompts')).toBeVisible({ timeout: 15000 });

        // Find the first available pre-configured prompt
        const promptItem = page.getByTestId('pre-configured-prompt-item').first();
        await expect(promptItem).toBeVisible({ timeout: 10000 });

        // Click pin button inside the item - use force to bypass Grafana 13 portal overlay
        const pinButton = promptItem.getByTitle('Pin prompt');
        await pinButton.click({ force: true });

        // Verify it is now pinned (title changes to "Unpin prompt")
        await expect(promptItem.getByTitle('Unpin prompt')).toBeVisible();

        // Unpin - use force to bypass Grafana 13 portal overlay
        await promptItem.getByTitle('Unpin prompt').click({ force: true });
        await expect(promptItem.getByTitle('Pin prompt')).toBeVisible();
    });
});
