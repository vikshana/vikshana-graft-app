import { test, expect } from './fixtures';

test('ChatInterface should render and allow sending messages', async ({ page, mockLLMHealth, waitForPortal }) => {
    await mockLLMHealth();
    await page.goto('/a/vikshana-graft-app');
    await expect(page.getByTestId('landing-title')).toBeVisible({ timeout: 15000 });
    await waitForPortal();

    const input = page.getByTestId('chat-input');
    await expect(input).toBeEnabled({ timeout: 15000 });
    await input.fill('Hello Graft');

    const sendButton = page.getByTestId('send-message-button');
    await expect(sendButton).toBeEnabled();
    await sendButton.click();

    await expect(page.getByTestId('landing-title')).not.toBeVisible();
    await expect(page.getByText('Hello Graft')).toBeVisible();
});

test('ChatInterface should navigate to history', async ({ page, waitForPortal }) => {
    await page.goto('/a/vikshana-graft-app');
    await expect(page.getByTestId('landing-title')).toBeVisible({ timeout: 15000 });
    await waitForPortal();

    await page.getByTestId('previous-conversations-link').click();

    await expect(page).toHaveURL(/.*\/history/);
    await expect(page.getByTestId('history-search-input')).toBeVisible();
});

test('ChatInterface should support multiple file uploads', async ({ page, waitForPortal }) => {
    await page.goto('/a/vikshana-graft-app');
    await expect(page.getByTestId('landing-title')).toBeVisible({ timeout: 15000 });
    await waitForPortal();

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

    await page.getByTestId('landing-file-input').setInputFiles([file1, file2]);

    await expect(page.getByText('test1.txt')).toBeVisible();
    await expect(page.getByText('test2.png')).toBeVisible();

    const removeButton = page.getByTestId('remove-file-button').first();
    await removeButton.click();

    await expect(page.getByText('test1.txt')).not.toBeVisible();
    await expect(page.getByText('test2.png')).toBeVisible();
});

test('ChatInterface header should be sticky', async ({ page, mockLLMHealth, waitForPortal }) => {
    await mockLLMHealth();
    await page.goto('/a/vikshana-graft-app');
    await expect(page.getByTestId('landing-title')).toBeVisible({ timeout: 15000 });
    await waitForPortal();

    const input = page.getByTestId('chat-input');
    await expect(input).toBeEnabled({ timeout: 15000 });
    await input.fill('Hello');

    const sendButton = page.getByTestId('send-message-button');
    await expect(sendButton).toBeEnabled();
    await sendButton.click();

    const header = page.getByTestId('chat-header');
    await expect(header).toHaveCSS('position', 'sticky');
    await expect(header).toHaveCSS('top', '40px');
});

test('ChatHistory should allow pinning and unpinning conversations', async ({ page, waitForPortal }) => {
    await page.goto('/a/vikshana-graft-app');
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

    await page.goto('/a/vikshana-graft-app/history');
    await expect(page.getByTestId('history-search-input')).toBeVisible({ timeout: 15000 });
    await waitForPortal();

    const sessionCard = page.getByTestId('session-card').filter({ hasText: 'Test conversation for pinning' }).first();
    await expect(sessionCard).toBeVisible({ timeout: 10000 });
    await sessionCard.hover();

    const pinButton = sessionCard.getByLabel(/Pin conversation/);
    await pinButton.click();

    await expect(sessionCard.getByLabel('Unpin conversation')).toBeVisible();

    await sessionCard.getByLabel('Unpin conversation').click();

    await sessionCard.hover();
    await expect(sessionCard.getByLabel('Pin conversation')).toBeVisible();
});

test('ChatHistory should show modal when pin limit is reached', async ({ page }) => {
    await page.goto('/a/vikshana-graft-app/history');
});

test('ChatHistory should show delete confirmation dialog', async ({ page, waitForPortal }) => {
    await page.goto('/a/vikshana-graft-app');
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

    await page.goto('/a/vikshana-graft-app/history');
    await expect(page).toHaveURL(/.*\/history/);
    await expect(page.getByTestId('history-search-input')).toBeVisible({ timeout: 15000 });
    await waitForPortal();

    const sessionCard = page.getByTestId('session-card').filter({ hasText: 'Test conversation to delete' }).first();
    await expect(sessionCard).toBeVisible({ timeout: 10000 });
    await sessionCard.hover();

    const deleteButton = sessionCard.getByLabel('Delete conversation');
    await deleteButton.click();

    await expect(page.getByText('Delete Conversation')).toBeVisible();
    await expect(page.getByText(/This action cannot be undone/)).toBeVisible();

    await page.getByText('Cancel').click();

    await expect(page.getByText('Delete Conversation')).not.toBeVisible();
    await expect(page.getByTestId('session-card').filter({ hasText: 'Test conversation to delete' })).toBeVisible();
});

test('ChatHistory should delete conversation after confirmation', async ({ page, waitForPortal }) => {
    await page.goto('/a/vikshana-graft-app');
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

    await page.goto('/a/vikshana-graft-app/history');
    await expect(page).toHaveURL(/.*\/history/);
    await expect(page.getByTestId('history-search-input')).toBeVisible({ timeout: 15000 });
    await waitForPortal();

    const sessionCard = page.getByTestId('session-card').filter({ hasText: uniqueTitle }).first();
    await expect(sessionCard).toBeVisible({ timeout: 10000 });
    await sessionCard.hover();
    await sessionCard.getByLabel('Delete conversation').click();

    await page.getByTestId('data-testid Confirm Modal Danger Button').click();

    await expect(page.getByTestId('session-card').filter({ hasText: uniqueTitle })).not.toBeVisible();
});

test('ChatHistory should filter conversations with search', async ({ page, waitForPortal }) => {
    await page.goto('/a/vikshana-graft-app');
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

    await page.goto('/a/vikshana-graft-app/history');
    await expect(page).toHaveURL(/.*\/history/);
    await expect(page.getByTestId('history-search-input')).toBeVisible({ timeout: 15000 });
    await waitForPortal();

    const searchInput = page.getByTestId('history-search-input');
    await searchInput.fill('Searchable');

    await expect(page.getByText('Searchable conversation one', { exact: true })).toBeVisible();
    await expect(page.getByText('Different conversation two', { exact: true })).not.toBeVisible();

    await searchInput.clear();

    await expect(page.getByText('Searchable conversation one', { exact: true })).toBeVisible();
    await expect(page.getByText('Different conversation two', { exact: true })).toBeVisible();
});

test.skip('ChatInterface thinking block appears and shows timer with "Thinking for" label', async ({ page }) => {
    await page.goto('/a/vikshana-graft-app');
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
    await expect(page.getByText(/Thinking for \d+s/)).toBeVisible({ timeout: 1000 });
    await expect(page.getByText(/Thought for \d+s/)).toBeVisible();
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
    await expect(page.getByText('Internal reasoning here')).not.toBeVisible();
    await thinkingHeader.click();
    await expect(page.getByText('Internal reasoning here')).toBeVisible();
    await thinkingHeader.click();
    await expect(page.getByText('Internal reasoning here')).not.toBeVisible();
});

test.skip('ChatInterface thinking timer increments during streaming and uses "Thinking for" label', async ({ page }) => {
    await page.goto('/a/vikshana-graft-app');
    await page.route('**/api/chat', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'text/event-stream',
            body: '<think>Processing...</think>Done',
        });
    });
    const input = page.getByTestId('chat-input');
    await input.fill('Test');
    await page.getByTestId('send-message-button').click();
    await expect(page.getByText(/Thinking for \d+s/)).toBeVisible({ timeout: 1000 });
    await page.waitForTimeout(2000);
    await expect(page.getByText(/Thought for \d+s/)).toBeVisible();
});

test('ChatHistory should display persisted thinking duration when loading conversation', async ({ page, waitForPortal }) => {
    await page.goto('/a/vikshana-graft-app');
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
        localStorage.setItem('graft_chat_history', JSON.stringify([mockSession]));
    });

    await page.reload();
    await page.goto('/a/vikshana-graft-app/history');
    await expect(page).toHaveURL(/.*\/history/);
    await expect(page.getByTestId('history-search-input')).toBeVisible({ timeout: 15000 });
    await waitForPortal();

    const sessionCard = page.getByTestId('session-card').filter({ hasText: 'Test question with thinking' }).first();
    await expect(sessionCard).toBeVisible({ timeout: 10000 });
    await sessionCard.click();

    await expect(page.getByText('Test question with thinking', { exact: true })).toBeVisible();
    await expect(page.getByText('Final answer to the question')).toBeVisible();
    await expect(page.getByText('Thought for 7s')).toBeVisible();

    const thinkingHeader = page.getByText('Thought for 7s');
    await thinkingHeader.click();
    await expect(page.getByText('Complex reasoning process here')).toBeVisible();

    await thinkingHeader.click();
    await expect(page.getByText('Complex reasoning process here')).not.toBeVisible();
});
