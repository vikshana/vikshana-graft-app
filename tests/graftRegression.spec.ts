/**
 * Graft historical failure regression — Playwright E2E against a real Grafana + LLM backend.
 * Do NOT use mockLLMHealth; these tests hit the deployed Graft operator path.
 *
 * Env vars:
 *   GRAFANA_URL=https://35.175.68.13   — remote Grafana (required for EC2)
 *   GRAFANA_E2E=1                      — gate read-only + mutating suites
 *   GRAFANA_E2E_MUTATING=1             — enable mutating dashboard/panel tests
 *   GRAFANA_MIN_BUILD=161              — optional build badge assertion
 *
 * Auth — pick one:
 *   A) One-time manual login, then reuse saved session:
 *        npm run test:regression:e2e:login
 *        GRAFANA_E2E=1 GRAFANA_REUSE_AUTH=1 npm run test:regression:e2e
 *   B) Pass the same Grafana web credentials:
 *        GRAFANA_ADMIN_USER=<username> GRAFANA_ADMIN_PASSWORD=<password>
 */
import {
    E2E_REGRESSION_CASES,
    E2E_MULTI_PANEL_DEFAULT_TITLES,
    e2eDashboardRowWithPanelsExpectContains,
    e2eDashboardRowWithPanelsPrompt,
    e2ePanelCreateExpectContains,
    e2ePanelCreatePrompt,
    e2ePanelRemovePrompt,
    e2ePanelRenameExpectContains,
    e2ePanelRenamePrompt,
} from '../src/services/regression/graftRegressionE2eFixtures';
import { test, expect } from './fixtures';
import {
    assertReplyExpectations,
    isGraftE2eMutatingEnabled,
    isGraftE2eTarget,
    openFreshGraftChat,
    removeE2ePanelsIfPresent,
    sendGraftPrompt,
    waitForAssistantReply,
} from './graftRegressionHelpers';

const readOnlyCases = E2E_REGRESSION_CASES.filter((c) => c.e2eEnabled && c.e2eMode === 'read-only');
const mutatingCases = E2E_REGRESSION_CASES.filter((c) => c.e2eEnabled && c.e2eMode === 'mutating');

const renameCase = mutatingCases.find((c) => c.id === 'panel-rename-not-dashboard');
const createCase = mutatingCases.find((c) => c.id === 'panel-create-bar-chart');
const multiPanelCase = mutatingCases.find((c) => c.id === 'multi-panel-create-types');
const rowWithPanelsCase = mutatingCases.find((c) => c.id === 'dashboard-row-with-panels');
const bulkGaugeCase = mutatingCases.find((c) => c.id === 'bulk-gauge-panel-rename');
const removeCase = mutatingCases.find((c) => c.id === 'panel-remove-verify');

test.describe('Graft regression E2E (read-only)', () => {
    test.describe.configure({ mode: 'serial' });
    test.skip(!isGraftE2eTarget(), 'Set GRAFANA_E2E=1 and GRAFANA_URL to a non-localhost instance');

    for (const regressionCase of readOnlyCases) {
        test(regressionCase.id, async ({ page }) => {
            test.setTimeout(regressionCase.replyTimeoutMs + 30_000);

            await openFreshGraftChat(page);
            const startCopyCount = await sendGraftPrompt(page, regressionCase.prompt);
            const reply = await waitForAssistantReply(page, {
                timeoutMs: regressionCase.replyTimeoutMs,
                startCopyCount,
            });

            assertReplyExpectations(
                reply,
                regressionCase.expectReplyContains,
                regressionCase.expectReplyNotContains
            );
            await expect(page.getByTestId('graft-continue-button')).not.toBeVisible();
        });
    }
});

test.describe('Graft regression E2E (mutating)', () => {
    test.describe.configure({ mode: 'serial' });
    test.skip(
        !isGraftE2eMutatingEnabled(),
        'Set GRAFANA_E2E=1, GRAFANA_URL, and GRAFANA_E2E_MUTATING=1'
    );

    let createdPanelName = '';
    let renamedPanelName = '';

    test('dashboard-row-with-panels', async ({ page }) => {
        if (!rowWithPanelsCase) {
            throw new Error('dashboard-row-with-panels E2E case missing');
        }
        test.setTimeout(rowWithPanelsCase.replyTimeoutMs + 60_000);

        const rowTitle = `Machine Health E2E ${Date.now()}`;
        const prompt = e2eDashboardRowWithPanelsPrompt(rowTitle);

        await openFreshGraftChat(page);
        const startCopyCount = await sendGraftPrompt(page, prompt);
        const reply = await waitForAssistantReply(page, {
            timeoutMs: rowWithPanelsCase.replyTimeoutMs,
            startCopyCount,
        });

        assertReplyExpectations(
            reply,
            e2eDashboardRowWithPanelsExpectContains(rowTitle),
            rowWithPanelsCase.expectReplyNotContains
        );
        await expect(page.getByTestId('graft-continue-button')).not.toBeVisible();
    });

    test('multi-panel-create-types', async ({ page }) => {
        if (!multiPanelCase) {
            throw new Error('multi-panel-create-types E2E case missing');
        }
        const removeTimeoutMs = removeCase?.replyTimeoutMs ?? multiPanelCase.replyTimeoutMs;
        test.setTimeout(removeTimeoutMs * (E2E_MULTI_PANEL_DEFAULT_TITLES.length + 1) + 60_000);

        await removeE2ePanelsIfPresent(page, E2E_MULTI_PANEL_DEFAULT_TITLES, e2ePanelRemovePrompt, {
            timeoutMs: removeTimeoutMs,
        });

        await openFreshGraftChat(page);
        const startCopyCount = await sendGraftPrompt(page, multiPanelCase.prompt);
        const reply = await waitForAssistantReply(page, {
            timeoutMs: multiPanelCase.replyTimeoutMs,
            startCopyCount,
        });

        assertReplyExpectations(
            reply,
            multiPanelCase.expectReplyContains,
            multiPanelCase.expectReplyNotContains
        );
        await expect(page.getByTestId('graft-continue-button')).not.toBeVisible();
    });

    test('bulk-gauge-panel-rename', async ({ page }) => {
        if (!bulkGaugeCase) {
            throw new Error('bulk-gauge-panel-rename E2E case missing');
        }
        test.setTimeout(bulkGaugeCase.replyTimeoutMs + 60_000);

        await openFreshGraftChat(page);
        const startCopyCount = await sendGraftPrompt(page, bulkGaugeCase.prompt);
        const reply = await waitForAssistantReply(page, {
            timeoutMs: bulkGaugeCase.replyTimeoutMs,
            startCopyCount,
        });

        assertReplyExpectations(
            reply,
            bulkGaugeCase.expectReplyContains,
            bulkGaugeCase.expectReplyNotContains
        );
        await expect(page.getByTestId('graft-continue-button')).not.toBeVisible();
    });

    test('panel-create-bar-chart', async ({ page }) => {
        if (!createCase) {
            throw new Error('panel-create-bar-chart E2E case missing');
        }
        test.setTimeout(createCase.replyTimeoutMs + 30_000);

        createdPanelName = `Cartridge Comparison E2E ${Date.now()}`;
        const prompt = e2ePanelCreatePrompt(createdPanelName);

        await openFreshGraftChat(page);
        const startCopyCount = await sendGraftPrompt(page, prompt);
        const reply = await waitForAssistantReply(page, {
            timeoutMs: createCase.replyTimeoutMs,
            startCopyCount,
        });

        assertReplyExpectations(
            reply,
            e2ePanelCreateExpectContains(createdPanelName),
            createCase.expectReplyNotContains
        );
        await expect(page.getByTestId('graft-continue-button')).not.toBeVisible();
    });

    test('panel-rename-not-dashboard', async ({ page }) => {
        if (!renameCase) {
            throw new Error('panel-rename-not-dashboard E2E case missing');
        }
        test.skip(!createdPanelName, 'Skipped: panel create did not run or did not set createdPanelName');
        test.setTimeout(renameCase.replyTimeoutMs + 30_000);

        renamedPanelName = `${createdPanelName} Renamed`;
        const prompt = e2ePanelRenamePrompt(createdPanelName, renamedPanelName);

        await openFreshGraftChat(page);
        const startCopyCount = await sendGraftPrompt(page, prompt);
        const reply = await waitForAssistantReply(page, {
            timeoutMs: renameCase.replyTimeoutMs,
            startCopyCount,
        });

        assertReplyExpectations(
            reply,
            e2ePanelRenameExpectContains(renamedPanelName),
            renameCase.expectReplyNotContains
        );
        await expect(page.getByTestId('graft-continue-button')).not.toBeVisible();
    });

    test('panel-remove-verify (cleanup)', async ({ page }) => {
        if (!removeCase) {
            throw new Error('panel-remove-verify E2E case missing');
        }
        test.skip(!renamedPanelName, 'Skipped: panel rename did not run or did not set renamedPanelName');
        test.setTimeout(removeCase.replyTimeoutMs + 30_000);

        const prompt = e2ePanelRemovePrompt(renamedPanelName);

        await openFreshGraftChat(page);
        const startCopyCount = await sendGraftPrompt(page, prompt);
        const reply = await waitForAssistantReply(page, {
            timeoutMs: removeCase.replyTimeoutMs,
            startCopyCount,
        });

        assertReplyExpectations(reply, removeCase.expectReplyContains, removeCase.expectReplyNotContains);
        await expect(page.getByTestId('graft-continue-button')).not.toBeVisible();
    });
});
