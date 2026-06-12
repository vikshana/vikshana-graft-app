import { AppConfigPage, AppPage, test as base } from '@grafana/plugin-e2e';
import { Page } from '@playwright/test';
import pluginJson from '../src/plugin.json';

type AppTestFixture = {
  appConfigPage: AppConfigPage;
  gotoPage: (path?: string) => Promise<AppPage>;
  mockLLMHealth: () => Promise<void>;
  waitForPortal: () => Promise<void>;
};

/**
 * Mock response for the LLM settings API endpoint.
 * This simulates an enabled LLM plugin.
 */
const mockLLMSettingsResponse = {
  enabled: true,
};

/**
 * Mock response for the LLM health API endpoint.
 * This simulates a configured and healthy LLM plugin with both base and large models available.
 */
const mockLLMHealthResponse = {
  details: {
    llmProvider: {
      configured: true,
      ok: true,
      models: {
        base: { ok: true },
        large: { ok: true },
      },
    },
  },
};

/**
 * Wait for the Grafana portal overlay to clear.
 * Grafana 13+ renders a transient div[role="presentation"] inside #grafana-portal-container
 * during plugin initialisation. While present it intercepts pointer events, preventing
 * React onClick handlers from firing even with { force: true }. Waiting for the container
 * to be empty ensures clicks reach the underlying elements.
 */
async function waitForPortalToClear(page: Page, timeout = 15000): Promise<void> {
  await page.waitForFunction(
    () => {
      const portal = document.getElementById('grafana-portal-container');
      return !portal || portal.children.length === 0;
    },
    { timeout }
  );
}

export const test = base.extend<AppTestFixture>({
  appConfigPage: async ({ gotoAppConfigPage }, use) => {
    const configPage = await gotoAppConfigPage({
      pluginId: pluginJson.id,
    });
    await use(configPage);
  },
  gotoPage: async ({ gotoAppPage }, use) => {
    await use((path) =>
      gotoAppPage({
        path,
        pluginId: pluginJson.id,
      })
    );
  },
  /**
   * Fixture to mock the LLM plugin API endpoints (settings and health).
   * Use this when tests need to interact with chat functionality (send messages, mode selection, etc.)
   * without requiring an actual LLM plugin to be configured.
   */
  mockLLMHealth: async ({ page }, use) => {
    const mockHealth = async () => {
      // Mock the settings endpoint (called first by llm.health())
      await page.route('**/api/plugins/grafana-llm-app/settings', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(mockLLMSettingsResponse),
        });
      });
      // Mock the health endpoint (called second by llm.health())
      await page.route('**/api/plugins/grafana-llm-app/health', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(mockLLMHealthResponse),
        });
      });
    };
    await use(mockHealth);
  },
  /**
   * Fixture that waits for the Grafana 13+ portal overlay to clear before tests interact
   * with the page. Call after page.goto() and any visibility checks.
   */
  waitForPortal: async ({ page }, use) => {
    await use(() => waitForPortalToClear(page));
  },
});

export { expect } from '@grafana/plugin-e2e';
