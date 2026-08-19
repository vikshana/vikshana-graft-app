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

    await page
        .waitForResponse(
            (response) =>
                response.url().includes('/resources/chat-history') && response.request().method() === 'GET',
            { timeout: 20_000 }
        )
        .catch(() => undefined);

    await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 20_000 });

    // Restored sessions open in chat view — Back resets to landing (handleReset).
    for (let attempt = 0; attempt < 3; attempt++) {
        if (await page.getByTestId('landing-title').isVisible().catch(() => false)) {
            break;
        }
        const backButton = page.getByTestId('back-button');
        if (await backButton.isVisible().catch(() => false)) {
            await backButton.click();
            await expect(page.getByTestId('landing-title')).toBeVisible({ timeout: 15_000 });
            break;
        }
        await page.waitForTimeout(400);
    }

    await expect(page.getByTestId('chat-input')).toBeVisible();

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
    const input = page.getByTestId('chat-input');
    await expect(input).toBeEnabled({ timeout: 20_000 });
    await input.fill(prompt);
    // Snapshot after fill so a late reply from the prior turn is not mistaken for this one.
    const startHeadingCount = await page.locator('main h3').count();
    await input.press('Enter');

    return startHeadingCount;
}

export async function waitForAssistantReply(
    page: Page,
    { timeoutMs, startCopyCount: startHeadingCount }: { timeoutMs: number; startCopyCount: number }
): Promise<string> {
    await expect
        .poll(
            async () => {
                const loading = await isGraftLoading(page);
                return loading;
            },
            { timeout: 10_000, intervals: [200, 500, 1000] }
        )
        .toBe(true)
        .catch(() => undefined);

    await expect
        .poll(
            async () => {
                const headingCount = await page.locator('main h3').count();
                const loading = await isGraftLoading(page);
                return headingCount > startHeadingCount && !loading;
            },
            { timeout: timeoutMs, intervals: [500, 1000, 2000] }
        )
        .toBe(true);

    return getLastAssistantMessageText(page);
}

export async function getLastAssistantMessageText(page: Page): Promise<string> {
    const heading = page.locator('main h3').last();
    await expect(heading).toBeVisible();
    const container = heading.locator('xpath=ancestor::div[contains(@class, "message")][1]');
    if ((await container.count()) > 0) {
        return ((await container.innerText()) ?? '').trim();
    }
    return ((await heading.locator('..').innerText()) ?? '').trim();
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

/** Best-effort cleanup so multi-panel create E2E can rerun on the same dashboard. */
export async function removeE2ePanelsIfPresent(
    page: Page,
    panelNames: readonly string[],
    removePrompt: (panelName: string) => string,
    { timeoutMs = 120_000 }: { timeoutMs?: number } = {}
): Promise<void> {
    for (const panelName of panelNames) {
        await openFreshGraftChat(page);
        const startCopyCount = await sendGraftPrompt(page, removePrompt(panelName));
        const reply = await waitForAssistantReply(page, { timeoutMs, startCopyCount });
        const lower = reply.toLowerCase();
        const removed = lower.includes('panel removed');
        const absent = lower.includes('could not find a matching panel');
        expect(
            removed || absent,
            `Unexpected remove reply for "${panelName}": ${reply.slice(0, 300)}`
        ).toBe(true);
    }
}

export async function deleteGrafanaAlertRuleIfPresent(page: Page, ruleUid: string): Promise<void> {
    const response = await page.request.delete(
        `/api/v1/provisioning/alert-rules/${encodeURIComponent(ruleUid)}`,
        { headers: { 'X-Disable-Provenance': 'true' } }
    );
    expect(
        [204, 404].includes(response.status()),
        `Could not delete alert rule ${ruleUid}: HTTP ${response.status()}`
    ).toBe(true);
}
