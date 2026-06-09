import { KEYSIGHT_DASHBOARD_UID, REGRESSION_CASES, type RegressionCase } from './graftRegressionFixtures';

export type E2eRegressionMode = 'read-only' | 'mutating';

export interface E2eRegressionCase {
    id: string;
    prompt: string;
    e2eEnabled: boolean;
    e2eMode: E2eRegressionMode;
    replyTimeoutMs: number;
    expectReplyContains?: string[];
    expectReplyNotContains?: string[];
}

const DEFAULT_REPLY_TIMEOUT_MS = 120_000;
const SLOW_REPLY_TIMEOUT_MS = 180_000;

function caseById(id: string): RegressionCase {
    const found = REGRESSION_CASES.find((c) => c.id === id);
    if (!found) {
        throw new Error(`Unknown regression case id: ${id}`);
    }
    return found;
}

function toE2eCase(
    id: string,
    overrides: Partial<E2eRegressionCase> & Pick<E2eRegressionCase, 'e2eEnabled' | 'e2eMode'>
): E2eRegressionCase {
    const base = caseById(id);
    return {
        id: base.id,
        prompt: base.prompt,
        replyTimeoutMs: DEFAULT_REPLY_TIMEOUT_MS,
        expectReplyContains: base.expectReplyContains,
        expectReplyNotContains: base.expectReplyNotContains,
        ...overrides,
    };
}

/** Playwright E2E metadata derived from historical Jest regression cases. */
export const E2E_REGRESSION_CASES: E2eRegressionCase[] = [
    toE2eCase('bulk-metric-panels', { e2eEnabled: false, e2eMode: 'mutating' }),
    toE2eCase('panel-rename-not-dashboard', {
        e2eEnabled: true,
        e2eMode: 'mutating',
        replyTimeoutMs: SLOW_REPLY_TIMEOUT_MS,
    }),
    toE2eCase('dashboard-review-suggest-only', {
        e2eEnabled: true,
        e2eMode: 'read-only',
    }),
    toE2eCase('panel-remove-verify', {
        e2eEnabled: true,
        e2eMode: 'mutating',
        replyTimeoutMs: SLOW_REPLY_TIMEOUT_MS,
    }),
    toE2eCase('llm-save-read-only-guard', { e2eEnabled: false, e2eMode: 'read-only' }),
    toE2eCase('panel-create-bar-chart', {
        e2eEnabled: true,
        e2eMode: 'mutating',
        replyTimeoutMs: SLOW_REPLY_TIMEOUT_MS,
    }),
    toE2eCase('review-no-auto-continue', { e2eEnabled: false, e2eMode: 'read-only' }),
];

export function e2ePanelCreatePrompt(panelName: string): string {
    return `Create a bar chart panel called "${panelName}" for Keysight.`;
}

export function e2ePanelRenamePrompt(sourceName: string, targetName: string): string {
    return `Rename the "${sourceName}" panel to "${targetName}" on dashboard UID = ${KEYSIGHT_DASHBOARD_UID}.`;
}

export function e2ePanelRemovePrompt(panelName: string): string {
    return `Remove the panel named "${panelName}" from dashboard UID = ${KEYSIGHT_DASHBOARD_UID}.`;
}

export function e2ePanelRenameExpectContains(targetName: string): string[] {
    return ['Panel renamed', targetName];
}

export function e2ePanelCreateExpectContains(panelName: string): string[] {
    return ['Panel created', panelName];
}
