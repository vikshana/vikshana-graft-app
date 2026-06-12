import { test, expect } from './fixtures';

test.describe('Prompt Library', () => {
    test('should navigate to prompt library and select a pre-configured prompt', async ({ page, mockLLMHealth, waitForPortal }) => {
        await mockLLMHealth();
        await page.goto('/a/vikshana-graft-app');
        await expect(page.getByTestId('landing-title')).toBeVisible({ timeout: 15000 });
        await waitForPortal();

        await page.getByTestId('prompt-library-link').click();
        await expect(page).toHaveURL(/.*\/prompts/);
        await expect(page.getByText('Pre-configured Prompts')).toBeVisible();

        const promptItem = page.getByTestId('pre-configured-prompt-item').first();
        await expect(promptItem).toBeVisible({ timeout: 10000 });

        await promptItem.click();

        await expect(page).toHaveURL(/\/a\/vikshana-graft-app$/);

        const input = page.getByTestId('chat-input');
        await expect(input).toBeEnabled({ timeout: 15000 });
        await expect(input).not.toHaveValue('');
    });

    test('should create, pin, and delete a user prompt', async ({ page, waitForPortal }) => {
        await page.goto('/a/vikshana-graft-app/prompts');
        await expect(page.getByText('Pre-configured Prompts')).toBeVisible({ timeout: 15000 });
        await waitForPortal();

        await page.getByText('My Prompts').click();

        const createButton = page.getByRole('button', { name: 'Create New Prompt' });
        await expect(createButton).toBeVisible();
        await createButton.click({ force: true });
        await page.getByPlaceholder('e.g., Debug K8s Pods').fill('E2E Test Prompt');
        await page.getByPlaceholder('Enter your prompt here...').fill('E2E Content');
        await page.getByRole('button', { name: 'Save' }).click({ force: true });

        await expect(page.getByText('E2E Test Prompt')).toBeVisible();

        const card = page.getByTestId('user-prompt-card').filter({ hasText: 'E2E Test Prompt' });
        await card.locator('button').first().click({ force: true });

        await card.locator('button').last().click({ force: true });
        const modal = page.locator('[role="dialog"]');
        await expect(modal).toBeVisible();
        await modal.getByRole('button', { name: 'Delete' }).click({ force: true });

        await expect(page.getByText('E2E Test Prompt')).not.toBeVisible();
    });

    test('should pin a pre-configured prompt', async ({ page, waitForPortal }) => {
        await page.goto('/a/vikshana-graft-app/prompts');
        await expect(page.getByText('Pre-configured Prompts')).toBeVisible({ timeout: 15000 });
        await waitForPortal();

        const promptItem = page.getByTestId('pre-configured-prompt-item').first();
        await expect(promptItem).toBeVisible({ timeout: 10000 });

        const pinButton = promptItem.getByTitle('Pin prompt');
        await pinButton.click();

        await expect(promptItem.getByTitle('Unpin prompt')).toBeVisible();

        await promptItem.getByTitle('Unpin prompt').click();
        await expect(promptItem.getByTitle('Pin prompt')).toBeVisible();
    });
});
