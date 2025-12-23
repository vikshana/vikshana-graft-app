import { test, expect } from './fixtures';

// NOTE: 'should be possible to save app configuration' test has been removed
// since model configuration is now handled by the Grafana LLM Plugin.
// This plugin's AppConfig only handles prompt library configuration.

test('should be possible to upload prompt library', async ({ appConfigPage, page }) => {
  // Create a dummy YAML file
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

  // In Playwright, we can set the input files directly
  // The file input has data-testid="prompt-library-upload"
  // Note: Grafana UI FileUpload might hide the actual input, so we might need to target the input inside it.
  // Usually it's an input[type="file"]

  // We'll use a buffer to simulate the file
  // The container has data-testid="prompt-library-upload-container"
  // We need to find the input[type="file"] inside it
  await page.locator('[data-testid="prompt-library-upload-container"] input[type="file"]').setInputFiles({
    name: 'prompts.yaml',
    mimeType: 'application/x-yaml',
    // @ts-ignore
    buffer: Buffer.from(yamlContent)
  });

  // Check for success message
  await expect(page.getByText(/Successfully loaded 1 categories/i)).toBeVisible();

  // Save - button is now just "Save" since model health checks are handled by Grafana LLM Plugin
  const saveButton = page.getByRole('button', { name: /^Save$/i });
  const saveResponse = appConfigPage.waitForSettingsResponse();
  await saveButton.click();
  await expect(saveResponse).toBeOK();
});
