import { expect, type Page } from '@playwright/test';

export function isGraftE2eTarget(): boolean {
    if (process.env.GRAFANA_E2E === '1') {
        return true;
    }
    const url = process.env.GRAFANA_URL?.trim();
    if (!url) {
        return false;
    }
    try {
        const { hostname } = new URL(url);
        return hostname !== 'localhost' && hostname !== '127.0.0.1';
    } catch {
        return false;
    }
}

export function isGraftE2eMutatingEnabled(): boolean {
    return isGraftE2eTarget() && process.env.GRAFANA_E2E_MUTATING === '1';
}

async function isGraftLoading(page: Page): Promise<boolean> {
    if (await page.getByText(/Thinking for \d+s/).isVisible().catch(() => false)) {
        return true;
    }

    const landingSend = page.getByTestId('send-message-button');
    if (await landingSend.isVisible().catch(() => false)) {
        return landingSend.isDisabled();
    }

    return page.locator('[title="Stop"]').isVisible().catch(() => false);
}

export async function openFreshGraftChat(page: Page): Promise<void> {
    await page.goto('/a/vikshana-graft-app');

    // Wait for server-side history hydration before resetting — otherwise restore races Back.
    await page
        .waitForResponse(
            (response) =>
                response.url().includes('/resources/chat-history') && response.request().method() === 'GET',
            { timeout: 20_000 }
        )
        .catch(() => undefined);

    const backButton = page.getByTestId('back-button');
    if (await backButton.isVisible().catch(() => false)) {
        await backButton.click();
    }

    await expect(page.getByTestId('landing-title')).toBeVisible({ timeout: 15_000 });

    const minBuild = process.env.GRAFANA_MIN_BUILD?.trim();
    if (minBuild) {
        const badge = page.getByTestId('graft-build-badge');
        await expect(badge).toBeVisible();
        const badgeText = (await badge.textContent()) ?? '';
        const match = badgeText.match(/\bbuild\s+(\d+)\b/i);
        expect(match, `Could not parse build number from badge: ${badgeText}`).not.toBeNull();
        expect(Number(match![1])).toBeGreaterThanOrEqual(Number(minBuild));
    }
}

export async function sendGraftPrompt(page: Page, prompt: string): Promise<number> {
    const startCopyCount = await page.getByTitle('Copy message').count();

    const input = page.getByTestId('chat-input');
    await input.fill(prompt);

    const landingSend = page.getByTestId('send-message-button');
    if (await landingSend.isVisible().catch(() => false)) {
        await landingSend.click();
        await expect(page.getByTestId('landing-title')).not.toBeVisible();
        return startCopyCount;
    }

    await input.press('Enter');
    return startCopyCount;
}

export async function waitForAssistantReply(
    page: Page,
    { timeoutMs, startCopyCount }: { timeoutMs: number; startCopyCount: number }
): Promise<string> {
    await expect
        .poll(
            async () => {
                const copyCount = await page.getByTitle('Copy message').count();
                const loading = await isGraftLoading(page);
                return copyCount > startCopyCount && !loading;
            },
            { timeout: timeoutMs, intervals: [500, 1000, 2000] }
        )
        .toBe(true);

    return getLastAssistantMessageText(page);
}

export async function getLastAssistantMessageText(page: Page): Promise<string> {
    const copyButton = page.getByTitle('Copy message').last();
    await expect(copyButton).toBeVisible();
    const content = copyButton.locator('xpath=preceding-sibling::*[1]');
    return ((await content.innerText()) ?? '').trim();
}

export function assertReplyExpectations(
    text: string,
    expectContains?: string[],
    expectNotContains?: string[]
): void {
    const lower = text.toLowerCase();

    for (const fragment of expectContains ?? []) {
        expect(lower, `Expected reply to contain "${fragment}"`).toContain(fragment.toLowerCase());
    }

    for (const fragment of expectNotContains ?? []) {
        expect(lower, `Expected reply not to contain "${fragment}"`).not.toContain(fragment.toLowerCase());
    }
}
