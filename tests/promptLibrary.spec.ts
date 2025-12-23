import { test, expect } from '@grafana/plugin-e2e';

test.describe('Prompt Library', () => {
    test('should navigate to prompt library and select a pre-configured prompt', async ({ page }) => {
        // Go to landing page
        await page.goto('/a/vikshana-graft-app');

        // Click Prompt Library link
        await page.getByTestId('prompt-library-link').click();
        await expect(page).toHaveURL(/.*\/prompts/);

        // Check for pre-configured prompts tab
        await expect(page.getByText('Pre-configured Prompts')).toBeVisible();

        // Wait for prompts to load and select the first available pre-configured prompt
        // We use an actual pre-configured prompt from the default library
        const promptItem = page.getByTestId('pre-configured-prompt-item').first();
        await expect(promptItem).toBeVisible({ timeout: 10000 });

        // Get the prompt content text before clicking
        const promptContent = await promptItem.locator('[data-testid="prompt-content"]').textContent()
            ?? await promptItem.textContent() ?? '';
        await promptItem.click();

        // Should navigate back to chat interface (base URL without /prompts)
        await expect(page).toHaveURL(/\/a\/vikshana-graft-app$/);

        // Check if input is populated with some content from the clicked prompt
        const input = page.getByTestId('chat-input');
        // The input should have some value after selecting a prompt
        await expect(input).not.toHaveValue('');
    });

    test('should create, pin, and delete a user prompt', async ({ page }) => {
        await page.goto('/a/vikshana-graft-app/prompts');

        // Switch to My Prompts
        await page.getByText('My Prompts').click();

        // Create new prompt
        await page.getByText('Create New Prompt').click();
        await page.getByPlaceholder('e.g., Debug K8s Pods').fill('E2E Test Prompt');
        await page.getByPlaceholder('Enter your prompt here...').fill('E2E Content');
        await page.getByText('Save').click();

        // Verify it appears
        await expect(page.getByText('E2E Test Prompt')).toBeVisible();

        // Pin it - target the pin button inside the user prompt card
        const card = page.getByTestId('user-prompt-card').filter({ hasText: 'E2E Test Prompt' });
        // The first button in card actions is pin
        await card.locator('button').first().click();

        // Delete it - target the delete button (last one)
        await card.locator('button').last().click();
        await page.getByText('Delete', { exact: true }).click(); // Confirm modal

        // Verify it's gone
        await expect(page.getByText('E2E Test Prompt')).not.toBeVisible();
    });

    test('should pin a pre-configured prompt', async ({ page }) => {
        await page.goto('/a/vikshana-graft-app/prompts');

        // Find the first available pre-configured prompt
        const promptItem = page.getByTestId('pre-configured-prompt-item').first();
        await expect(promptItem).toBeVisible({ timeout: 10000 });

        // Click pin button inside the item
        const pinButton = promptItem.getByTitle('Pin prompt');
        await pinButton.click();

        // Verify it is now pinned (title changes to "Unpin prompt")
        await expect(promptItem.getByTitle('Unpin prompt')).toBeVisible();

        // Unpin
        await promptItem.getByTitle('Unpin prompt').click();
        await expect(promptItem.getByTitle('Pin prompt')).toBeVisible();
    });
});
