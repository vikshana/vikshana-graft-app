import { AppConfigPage, AppPage, test as base } from '@grafana/plugin-e2e';
import pluginJson from '../src/plugin.json';

type AppTestFixture = {
  appConfigPage: AppConfigPage;
  gotoPage: (path?: string) => Promise<AppPage>;
  mockLLMHealth: () => Promise<void>;
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
});

export { expect } from '@grafana/plugin-e2e';
