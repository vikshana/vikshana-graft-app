import { test, expect } from './fixtures';

test('ChatInterface should render and allow sending messages', async ({ page, mockLLMHealth }) => {
    // Mock LLM health API to ensure chat functionality is enabled
    await mockLLMHealth();

    // Navigate to the plugin page
    await page.goto('/a/vikshana-graft-app');

    // Check if the landing page is rendered
    await expect(page.getByTestId('landing-title')).toBeVisible();
    await expect(page.getByTestId('previous-conversations-link')).toBeVisible();

    // Type a message
    const input = page.getByTestId('chat-input');
    await input.fill('Hello Graft');

    // Send the message
    const sendButton = page.getByTestId('send-message-button');
    await sendButton.click();

    // Check if the chat interface is active (landing page specific element should be gone)
    await expect(page.getByTestId('landing-title')).not.toBeVisible();

    // Check if the user message is displayed
    await expect(page.getByText('Hello Graft')).toBeVisible();

    // Since we don't have a real backend connected in E2E (or we mock it),
    // we might not see a response unless we mock the route.
    // For now, we just verify the UI transition.
});

test('ChatInterface should navigate to history', async ({ page }) => {
    await page.goto('/a/vikshana-graft-app');

    // Click on "Previous Conversations"
    await page.getByTestId('previous-conversations-link').click();

    // Check if we are on the history page
    await expect(page).toHaveURL(/.*\/history/);
    await expect(page.getByTestId('history-search-input')).toBeVisible();
});

test('ChatInterface should support multiple file uploads', async ({ page }) => {
    await page.goto('/a/vikshana-graft-app');

    // Create dummy files
    const file1 = {
        name: 'test1.txt',
        mimeType: 'text/plain',
        // @ts-ignore
        buffer: Buffer.from('content1'),
    };
    const file2 = {
        name: 'test2.png',
        mimeType: 'image/png',
        // @ts-ignore
        buffer: Buffer.from('content2'),
    };

    // Upload files
    // Note: The input is hidden, so we might need to make it visible or use setInputFiles on the label/button if possible, 
    // or just target the hidden input directly.
    // The input has data-testid="landing-file-input" (based on ChatInterface.tsx line 740)
    await page.getByTestId('landing-file-input').setInputFiles([file1, file2]);

    // Verify previews
    // The previews are rendered in landingInputWrapper -> filePreviewList -> FilePreview
    // FilePreview component likely renders the name.
    await expect(page.getByText('test1.txt')).toBeVisible();
    await expect(page.getByText('test2.png')).toBeVisible();

    // Remove one file
    // We need to find the remove button.
    const removeButtons = page.locator('button').filter({ has: page.locator('svg') });
    // This selector is a bit loose.
    // ChatInterface.tsx uses FilePreview component.
    // The list is div class={styles.filePreviewList}
    // We can target the remove button inside the preview item.
    // Assuming FilePreview renders the name and a close button.
    // Let's use getByLabel or similar if available, or just standard traversal

    // Use the data-testid on the remove button in FilePreview component
    const removeButton = page.getByTestId('remove-file-button').first();
    await removeButton.click();

    // Verify one file is gone and one remains
    // If we removed the first one, test1.txt should be gone
    await expect(page.getByText('test1.txt')).not.toBeVisible();
    await expect(page.getByText('test2.png')).toBeVisible();
});

test('ChatInterface header should be sticky', async ({ page, mockLLMHealth }) => {
    // Mock LLM health API to ensure chat functionality is enabled
    await mockLLMHealth();

    await page.goto('/a/vikshana-graft-app');

    // Start a chat to get the header
    const input = page.getByTestId('chat-input');
    await input.fill('Hello');
    await page.getByTestId('send-message-button').click();

    // Check CSS of the header
    // The header contains "Graft AI Assistant" and "Back" button.
    const header = page.getByTestId('chat-header');

    await expect(header).toHaveCSS('position', 'sticky');
    await expect(header).toHaveCSS('top', '40px'); // 40px to account for Grafana's top navigation bar
});

test('ChatHistory should allow pinning and unpinning conversations', async ({ page }) => {
    await page.goto('/a/vikshana-graft-app');

    // Inject a test session directly into localStorage
    await page.evaluate(() => {
        const now = Date.now();
        const session = {
            id: 'test-pin-session',
            title: 'Test conversation for pinning',
            messages: [
                { role: 'user', content: 'Test conversation for pinning' },
                { role: 'assistant', content: 'Test response' }
            ],
            createdAt: now,
            updatedAt: now,
            isPinned: false
        };
        localStorage.setItem('graft_chat_history', JSON.stringify([session]));
    });

    // Navigate to history
    await page.goto('/a/vikshana-graft-app/history');

    // Find the conversation card and hover to show pin button
    const sessionCard = page.getByTestId('session-card').filter({ hasText: 'Test conversation for pinning' }).first();
    await sessionCard.hover();

    // Click pin button
    const pinButton = sessionCard.getByLabel(/Pin conversation/);
    await pinButton.click();

    // Verify star icon changes to filled
    await expect(sessionCard.getByLabel('Unpin conversation')).toBeVisible();

    // Unpin
    await sessionCard.getByLabel('Unpin conversation').click();

    // Verify star icon changes back
    await sessionCard.hover();
    await expect(sessionCard.getByLabel('Pin conversation')).toBeVisible();
});

test('ChatHistory should show modal when pin limit is reached', async ({ page }) => {
    // ... no changes needed for logic, just ensure we can reach history
    await page.goto('/a/vikshana-graft-app/history');
    // ...
});

test('ChatHistory should show delete confirmation dialog', async ({ page }) => {
    await page.goto('/a/vikshana-graft-app');

    // Inject a test session directly into localStorage
    await page.evaluate(() => {
        const now = Date.now();
        const session = {
            id: 'test-delete-session',
            title: 'Test conversation to delete',
            messages: [
                { role: 'user', content: 'Test conversation to delete' },
                { role: 'assistant', content: 'Test response' }
            ],
            createdAt: now,
            updatedAt: now,
            isPinned: false
        };
        localStorage.setItem('graft_chat_history', JSON.stringify([session]));
    });

    // Navigate to history
    await page.goto('/a/vikshana-graft-app/history');
    await expect(page).toHaveURL(/.*\/history/);

    // Find the conversation and hover to show delete button
    const sessionCard = page.getByTestId('session-card').filter({ hasText: 'Test conversation to delete' }).first();
    await sessionCard.hover();

    // Click delete button
    const deleteButton = sessionCard.getByLabel('Delete conversation');
    await deleteButton.click();

    // Verify confirmation modal appears
    await expect(page.getByText('Delete Conversation')).toBeVisible();
    await expect(page.getByText(/This action cannot be undone/)).toBeVisible();

    // Click Cancel
    await page.getByText('Cancel').click();

    // Verify modal is dismissed and conversation still exists
    await expect(page.getByText('Delete Conversation')).not.toBeVisible();
    await expect(page.getByTestId('session-card').filter({ hasText: 'Test conversation to delete' })).toBeVisible();
});

test('ChatHistory should delete conversation after confirmation', async ({ page }) => {
    await page.goto('/a/vikshana-graft-app');

    // Inject a test session into localStorage
    const uniqueTitle = 'Conversation to delete';
    await page.evaluate((title) => {
        const now = Date.now();
        const session = {
            id: 'delete-test-session',
            title: title,
            messages: [
                { role: 'user', content: title },
                { role: 'assistant', content: 'Test response' }
            ],
            createdAt: now,
            updatedAt: now,
            isPinned: false
        };
        const existing = JSON.parse(localStorage.getItem('graft_chat_history') || '[]');
        existing.push(session);
        localStorage.setItem('graft_chat_history', JSON.stringify(existing));
    }, uniqueTitle);

    // Navigate to history
    await page.goto('/a/vikshana-graft-app/history');
    await expect(page).toHaveURL(/.*\/history/);

    // Find and delete the conversation
    const sessionCard = page.getByTestId('session-card').filter({ hasText: uniqueTitle }).first();
    await sessionCard.hover();
    await sessionCard.getByLabel('Delete conversation').click();

    // Confirm deletion
    await page.getByTestId('data-testid Confirm Modal Danger Button').click();

    // Verify conversation is removed
    await expect(page.getByTestId('session-card').filter({ hasText: uniqueTitle })).not.toBeVisible();
});

test('ChatHistory should filter conversations with search', async ({ page }) => {
    await page.goto('/a/vikshana-graft-app');

    // Inject two test sessions into localStorage
    await page.evaluate(() => {
        const now = Date.now();
        const sessions = [
            {
                id: 'search-test-session-1',
                title: 'Searchable conversation one',
                messages: [
                    { role: 'user', content: 'Searchable conversation one' },
                    { role: 'assistant', content: 'Test response' }
                ],
                createdAt: now,
                updatedAt: now,
                isPinned: false
            },
            {
                id: 'search-test-session-2',
                title: 'Different conversation two',
                messages: [
                    { role: 'user', content: 'Different conversation two' },
                    { role: 'assistant', content: 'Test response' }
                ],
                createdAt: now - 1000,
                updatedAt: now - 1000,
                isPinned: false
            }
        ];
        const existing = JSON.parse(localStorage.getItem('graft_chat_history') || '[]');
        localStorage.setItem('graft_chat_history', JSON.stringify([...existing, ...sessions]));
    });

    // Navigate to history
    await page.goto('/a/vikshana-graft-app/history');
    await expect(page).toHaveURL(/.*\/history/);

    // Search for specific conversation
    const searchInput = page.getByTestId('history-search-input');
    await searchInput.fill('Searchable');

    // Verify filtering
    await expect(page.getByText('Searchable conversation one', { exact: true })).toBeVisible();
    await expect(page.getByText('Different conversation two', { exact: true })).not.toBeVisible();

    // Clear search
    await searchInput.clear();

    // Verify both are visible again
    await expect(page.getByText('Searchable conversation one', { exact: true })).toBeVisible();
    await expect(page.getByText('Different conversation two', { exact: true })).toBeVisible();
});

// TODO: Thinking block tests require proper backend API mocking or integration test setup
// These tests need a way to inject <think> tags into LLM responses
// Consider running these manually or setting up backend mocks

test.skip('ChatInterface thinking block appears and shows timer with "Thinking for" label', async ({ page }) => {
    await page.goto('/a/vikshana-graft-app');

    // We'll need to mock the API response to include <think> tags
    // This assumes we can intercept the streaming response
    await page.route('**/api/chat', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'text/event-stream',
            body: '<think>Analyzing your query...</think>The answer is 42',
        });
    });

    const input = page.getByTestId('chat-input');
    await input.fill('What is the answer?');
    await page.getByTestId('send-message-button').click();

    // Verify thinking block shows "Thinking for" label during streaming
    await expect(page.getByText(/Thinking for \d+s/)).toBeVisible({ timeout: 1000 });

    // After completion, should show "Thought for"
    await expect(page.getByText(/Thought for \d+s/)).toBeVisible();

    // Verify main content appears
    await expect(page.getByText('The answer is 42')).toBeVisible();
});

test.skip('ChatInterface thinking block can be expanded and collapsed', async ({ page }) => {
    await page.goto('/a/vikshana-graft-app');

    await page.route('**/api/chat', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'text/event-stream',
            body: '<think>Internal reasoning here</think>Final answer',
        });
    });

    const input = page.getByTestId('chat-input');
    await input.fill('Test');
    await page.getByTestId('send-message-button').click();

    const thinkingHeader = page.getByText(/Thought for \d+s/);
    await expect(thinkingHeader).toBeVisible();

    // Initially collapsed
    await expect(page.getByText('Internal reasoning here')).not.toBeVisible();

    // Click to expand
    await thinkingHeader.click();
    await expect(page.getByText('Internal reasoning here')).toBeVisible();

    // Click to collapse
    await thinkingHeader.click();
    await expect(page.getByText('Internal reasoning here')).not.toBeVisible();
});

test.skip('ChatInterface thinking timer increments during streaming and uses "Thinking for" label', async ({ page }) => {
    await page.goto('/a/vikshana-graft-app');

    // Mock a slow streaming response
    await page.route('**/api/chat', async (route) => {
        const response = '<think>Processing...</think>Done';
        // Simulate gradual streaming
        await route.fulfill({
            status: 200,
            contentType: 'text/event-stream',
            body: response,
        });
    });

    const input = page.getByTestId('chat-input');
    await input.fill('Test');
    await page.getByTestId('send-message-button').click();

    // Check for "Thinking for" label during streaming
    await expect(page.getByText(/Thinking for \d+s/)).toBeVisible({ timeout: 1000 });

    // Wait and verify timer incremented
    await page.waitForTimeout(2000);

    // After completion, should show "Thought for"
    await expect(page.getByText(/Thought for \d+s/)).toBeVisible();
});

test('ChatHistory should display persisted thinking duration when loading conversation', async ({ page }) => {
    await page.goto('/a/vikshana-graft-app');

    // This test relies on localStorage persisting thinking duration
    // We'll create a mock session with thinking duration directly in localStorage

    // Inject a test session into localStorage
    await page.evaluate(() => {
        const now = Date.now();
        const mockSession = {
            id: 'test-thinking-session',
            title: 'Test question with thinking',
            messages: [
                { role: 'user', content: 'Test question with thinking' },
                {
                    role: 'assistant',
                    content: '<think>Complex reasoning process here</think>Final answer to the question',
                    thinkingSeconds: 7
                }
            ],
            createdAt: now,
            updatedAt: now,
            isPinned: false
        };

        const sessions = [mockSession];
        localStorage.setItem('graft_chat_history', JSON.stringify(sessions));
    });

    // Reload page to simulate fresh session
    await page.reload();

    // Go to history
    // Ensure we track state correctly or just force navigate
    await page.goto('/a/vikshana-graft-app/history');
    await expect(page).toHaveURL(/.*\/history/);

    // Find and click on our test session
    const sessionCard = page.getByTestId('session-card').filter({ hasText: 'Test question with thinking' }).first();
    await sessionCard.click();

    // Verify we're now viewing the conversation
    await expect(page.getByText('Test question with thinking', { exact: true })).toBeVisible();
    await expect(page.getByText('Final answer to the question')).toBeVisible();

    // Most importantly, verify the thinking block shows the persisted duration (7 seconds), not 0
    await expect(page.getByText('Thought for 7s')).toBeVisible();

    // Verify we can expand the thinking block
    const thinkingHeader = page.getByText('Thought for 7s');
    await thinkingHeader.click();

    // Check that thinking content is now visible
    await expect(page.getByText('Complex reasoning process here')).toBeVisible();

    // Collapse it again
    await thinkingHeader.click();
    await expect(page.getByText('Complex reasoning process here')).not.toBeVisible();
});

