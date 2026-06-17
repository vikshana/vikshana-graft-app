import { test, expect } from './fixtures';

// The Agent config tab is registered at /plugins/vikshana-graft-app?page=agent.
// The four fixed OSS tool categories (loki, prometheus, dashboards, datasources)
// always render regardless of MCP server availability, so these tests require
// no LLM or MCP mock — they exercise pure form interactions.

test.describe('Agent config tab', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/plugins/vikshana-graft-app?page=agent');
        // Wait for the page to load — the OSS tier header is always present
        await expect(page.getByTestId('tier-header-oss')).toBeVisible({ timeout: 15000 });
    });

    test('shows the OSS tier section with the four fixed categories', async ({ page }) => {
        await expect(page.getByTestId('tier-header-oss')).toBeVisible();

        // All four fixed categories are present
        await expect(page.getByTestId('tool-category-loki')).toBeVisible();
        await expect(page.getByTestId('tool-category-prometheus')).toBeVisible();
        await expect(page.getByTestId('tool-category-dashboards')).toBeVisible();
        await expect(page.getByTestId('tool-category-datasources')).toBeVisible();
    });

    test('category card expands and collapses on header click', async ({ page }) => {
        const lokiHeader = page.getByTestId('tool-category-header-loki');
        await expect(lokiHeader).toBeVisible();

        // Click to expand
        await lokiHeader.click();
        const toolList = page.getByTestId('tool-list-loki');
        await expect(toolList).toBeVisible();

        // Click again to collapse
        await lokiHeader.click();
        await expect(toolList).not.toBeVisible();
    });

    test('expanded category shows per-tool checkboxes', async ({ page }) => {
        // Expand the prometheus category
        await page.getByTestId('tool-category-header-prometheus').click();
        const toolList = page.getByTestId('tool-list-prometheus');
        await expect(toolList).toBeVisible();

        // query_prometheus is one of the prometheus tools
        await expect(page.getByTestId('tool-checkbox-query_prometheus')).toBeVisible();
        await expect(page.getByTestId('tool-checkbox-list_prometheus_label_names')).toBeVisible();
    });

    test('disabling a category disables its per-tool checkboxes', async ({ page }) => {
        // Expand loki first
        await page.getByTestId('tool-category-header-loki').click();
        await expect(page.getByTestId('tool-list-loki')).toBeVisible();

        // Uncheck the category-level checkbox — use force since the label may intercept
        const catCheckbox = page.getByTestId('tool-category-checkbox-loki');
        await expect(catCheckbox).toBeChecked();
        await catCheckbox.click({ force: true });
        await expect(catCheckbox).not.toBeChecked();

        // Per-tool checkboxes should be disabled
        const toolCheckbox = page.getByTestId('tool-checkbox-query_loki_logs');
        await expect(toolCheckbox).toBeDisabled();

        // Re-enable the category
        await catCheckbox.click({ force: true });
        await expect(catCheckbox).toBeChecked();
        await expect(toolCheckbox).toBeEnabled();
    });

    test('max-tool-iterations input is visible and accepts numeric input', async ({ page }) => {
        const input = page.getByTestId('max-tool-iterations-input');
        await expect(input).toBeVisible();

        // Should have a default value
        const currentValue = await input.inputValue();
        expect(Number(currentValue)).toBeGreaterThan(0);

        // Edit it
        await input.fill('25');
        await expect(input).toHaveValue('25');
    });

    test('saving agent settings posts to the plugin settings endpoint', async ({ page }) => {
        // The beforeEach already navigated to ?page=agent
        const input = page.getByTestId('max-tool-iterations-input');
        await expect(input).toBeVisible();
        await input.fill('30');

        // Wait for the settings POST response when Save is clicked
        const saveResponse = page.waitForResponse(
            resp => resp.url().includes('/api/plugins/vikshana-graft-app/settings') && resp.request().method() === 'POST'
        );
        await page.getByRole('button', { name: /Save/i }).click();
        const resp = await saveResponse;
        expect(resp.ok()).toBe(true);
    });
});
