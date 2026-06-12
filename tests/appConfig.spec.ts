import { test, expect } from './fixtures';

// NOTE: 'should be possible to save app configuration' test has been removed
// since model configuration is now handled by the Grafana LLM Plugin.
// This plugin's AppConfig only handles prompt library configuration.

test('should be possible to upload prompt library', async ({ appConfigPage, page, waitForPortal }) => {
  // Wait for the Grafana portal overlay to clear before interacting
  await waitForPortal();

  const yamlContent = `
- id: "e2e-test"
  name: "E2E Test Category"
  subCategories:
    - id: "e2e-sub"
      name: "E2E Sub"
      prompts:
        - name: "E2E Prompt"
          content: "E2E Content"
`;

  await page.locator('[data-testid="prompt-library-upload-container"] input[type="file"]').setInputFiles({
    name: 'prompts.yaml',
    mimeType: 'application/x-yaml',
    // @ts-ignore
    buffer: Buffer.from(yamlContent)
  });

  await expect(page.getByText(/Successfully loaded 1 categories/i)).toBeVisible();

  const saveButton = page.getByRole('button', { name: /^Save$/i });
  const saveResponse = appConfigPage.waitForSettingsResponse();
  await saveButton.click();
  await expect(saveResponse).toBeOK();
});
