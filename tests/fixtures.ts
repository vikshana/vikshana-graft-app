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
 * Wait for the Grafana portal overlay to stop intercepting pointer events.
 * Grafana 13 Enterprise renders a trial/license modal inside #grafana-portal-container
 * on startup. We dismiss it if present, then wait for any remaining blocking overlay
 * (div[role="presentation"] without an aria-label, which is a backdrop) to clear.
 */
async function waitForPortalToClear(page: Page, timeout = 15000): Promise<void> {
  // Dismiss any Grafana Enterprise trial/license dialog that may be blocking the UI
  try {
    const dismissSelectors = [
      'button[aria-label="Close dialogue"]',
      'button[aria-label="Close"]',
      '[aria-label="Dismiss"]',
      'button:has-text("Maybe later")',
      'button:has-text("Skip")',
      'button:has-text("Close")',
    ];
    for (const selector of dismissSelectors) {
      const btn = page.locator(selector).first();
      if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
        await btn.click({ force: true });
        break;
      }
    }
  } catch {
    // Ignore — no dialog to dismiss
  }

  // Wait for any full-viewport backdrop (role="presentation" with no meaningful content)
  // to clear from the portal container, with a generous timeout
  await page.waitForFunction(
    () => {
      const portal = document.getElementById('grafana-portal-container');
      if (!portal) {
        return true;
      }
      // A blocking backdrop is a div[role="presentation"] that covers the full viewport
      const backdrops = Array.from(portal.querySelectorAll('[role="presentation"]')) as HTMLElement[];
      const blocking = backdrops.find((el) => {
        const r = el.getBoundingClientRect();
        return r.width > window.innerWidth * 0.9 && r.height > window.innerHeight * 0.9;
      });
      return !blocking;
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
