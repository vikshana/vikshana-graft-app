import { KEYSIGHT_DASHBOARD_UID, REGRESSION_CASES, type RegressionCase } from './graftRegressionFixtures';

/**
 * Sandbox Playwright target: cloned Keysight (`2505-200033 / Keysight — Graft E2E`).
 * Jest operator fixtures still use historical `cfo0wckufbdhce`.
 */
export const SANDBOX_E2E_DASHBOARD_UID = 'grafte2ekeysht';

export function e2eDashboardUid(): string {
    return process.env.GRAFANA_E2E_DASHBOARD_UID?.trim() || SANDBOX_E2E_DASHBOARD_UID;
}

function withE2eDashboardUid(prompt: string): string {
    const uid = e2eDashboardUid();
    return prompt.split(KEYSIGHT_DASHBOARD_UID).join(uid).split('afq7tc6hl1m9sb').join(uid);
}

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
    const merged: E2eRegressionCase = {
        id: base.id,
        prompt: base.prompt,
        replyTimeoutMs: DEFAULT_REPLY_TIMEOUT_MS,
        expectReplyContains: base.expectReplyContains,
        expectReplyNotContains: base.expectReplyNotContains,
        ...overrides,
    };
    merged.prompt = withE2eDashboardUid(merged.prompt);
    return merged;
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
    toE2eCase('ambiguous-graphs-keysight', {
        e2eEnabled: true,
        e2eMode: 'read-only',
        replyTimeoutMs: 30_000,
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
    toE2eCase('multi-panel-create-types', {
        e2eEnabled: true,
        e2eMode: 'mutating',
        replyTimeoutMs: SLOW_REPLY_TIMEOUT_MS,
    }),
    toE2eCase('dashboard-row-with-panels', {
        e2eEnabled: true,
        e2eMode: 'mutating',
        replyTimeoutMs: SLOW_REPLY_TIMEOUT_MS,
    }),
    toE2eCase('bulk-gauge-panel-rename', {
        e2eEnabled: true,
        e2eMode: 'mutating',
        replyTimeoutMs: SLOW_REPLY_TIMEOUT_MS,
    }),
    toE2eCase('review-no-auto-continue', { e2eEnabled: false, e2eMode: 'read-only' }),
    toE2eCase('create-organization-admin', { e2eEnabled: true, e2eMode: 'read-only' }),
    toE2eCase('add-user-admin', { e2eEnabled: true, e2eMode: 'read-only' }),
    toE2eCase('rf-bare-pressure-clarify', { e2eEnabled: true, e2eMode: 'read-only' }),
];

export function e2ePanelCreatePrompt(panelName: string): string {
    return `Create a bar chart panel called "${panelName}" on dashboard UID = ${e2eDashboardUid()}.`;
}

export function e2ePanelRenamePrompt(sourceName: string, targetName: string): string {
    return `Rename the "${sourceName}" panel to "${targetName}" on dashboard UID = ${e2eDashboardUid()}.`;
}

export function e2ePanelRemovePrompt(panelName: string): string {
    return `Remove the panel named "${panelName}" from dashboard UID = ${e2eDashboardUid()}.`;
}

export function e2ePanelRenameExpectContains(targetName: string): string[] {
    return ['Panel renamed', targetName];
}

export function e2ePanelCreateExpectContains(panelName: string): string[] {
    return ['Panel created', panelName];
}

export function e2eDashboardRowWithPanelsPrompt(rowTitle: string): string {
    return `Create a dashboard row called "${rowTitle}" and add two panels to it for dashboard with UID = ${e2eDashboardUid()}.`;
}

export function e2eDashboardRowWithPanelsExpectContains(rowTitle: string): string[] {
    return ['Row and panels created', rowTitle];
}

/** Sandbox Skywater-MN — RF vs Peers panel lives here, not on the Keysight E2E clone. */
export const SANDBOX_SKYWATER_DASHBOARD_UID = 'idHkqdqnk';

export function e2eGrafanaAlertCreatePrompt(ruleTitle: string): string {
    return (
        `Create a Grafana-managed alert named "${ruleTitle}" for the panel titled ` +
        `"Module 2 Current — RandomForest vs Peers" on the dashboard with UID ${SANDBOX_SKYWATER_DASHBOARD_UID}. ` +
        `Configure the alert to trigger when the RandomForest model identifies Module 2 Current as anomalous compared with its peer modules. ` +
        `The anomalous condition must remain true for longer than 1 minute before the alert fires. ` +
        `Do not invent an arbitrary RandomForest threshold. ` +
        `Configure the alert to notify the Alex Test Email contact point.`
    );
}

export const E2E_GRAFANA_ALERT_CREATE_RULE_TITLE = 'Graft E2E RF vs Peers';

export function e2eGrafanaAlertCreateExpectContains(ruleTitle: string): string[] {
    return [ruleTitle, SANDBOX_SKYWATER_DASHBOARD_UID, 'Alex Test Email', 'RandomForest vs Peers'];
}

export const E2E_GRAFANA_ALERT_CREATE_EXPECT_NOT_CONTAINS = [
    'Need clarification',
    'typical Own History layout',
] as const;

export function e2eGrafanaAlertUpdatePrompt(ruleTitle: string, description: string): string {
    return (
        `Change the alert rule named "${ruleTitle}" on the dashboard with UID = ${SANDBOX_SKYWATER_DASHBOARD_UID} ` +
        `to have the description of "${description}"`
    );
}

export function e2eGrafanaAlertUpdateExpectContains(description: string): string[] {
    return ['Grafana alert updated', description];
}

export function e2ePeerRfPanelCreatePrompt(panelTitle: string): string {
    return (
        `Create a machine learning panel titled "${panelTitle}" on the dashboard with UID ${e2eDashboardUid()}. ` +
        `Compare Module 2 Current against the peer modules using a RandomForest anomaly detection model. ` +
        `Plot the Module 2 Actual values and the RandomForest anomaly score or prediction. ` +
        `If a RandomForest model is not available, explain what additional configuration or data is required instead of creating placeholder queries`
    );
}

export const E2E_PEER_RF_CREATE_EXPECT_NOT_CONTAINS = ['History Comparison'] as const;

/** Tiny unused machines so clone does not overwrite Keysight or Skywater. */
export const E2E_CLONE_SOURCE_MACHINE = '2598-000001';
export const E2E_CLONE_SOURCE_DASHBOARD_UID = 'grafte2eclsrc';
export const E2E_CLONE_TARGET_MACHINE = '2599-000001';

export function e2eDashboardClonePrompt(dashboardTitle: string): string {
    return (
        `Create a new dashboard named "${dashboardTitle}" that is a visual copy of ${E2E_CLONE_SOURCE_MACHINE}, ` +
        `with data for ${E2E_CLONE_TARGET_MACHINE}.`
    );
}

export function extractClonedDashboardUidFromReply(reply: string): string | undefined {
    const match = reply.match(/New dashboard:[^\n]*?\(\`?([A-Za-z0-9_-]{8,})\`?\)/i);
    return match?.[1];
}

export function e2ePeerBandPressureCreatePrompt(panelTitle: string): string {
    return (
        `Create a new machine learning time series panel titled "${panelTitle}" ` +
        `on the dashboard with UID ${e2eDashboardUid()}. ` +
        `Compare Module 2 Pressure against the average of Modules 1 and 3 through 8. ` +
        `Create four visible lines: Module 2 Actual Peer Mean Upper Peer Bound (Peer Mean + 2 × Standard Deviation) ` +
        `Lower Peer Bound (Peer Mean - 2 × Standard Deviation) Calculate the Upper and Lower Peer Bounds in the Flux query itself.`
    );
}

export function e2eSensingVoltageHistoryComparisonPrompt(dashboardUid: string): string {
    return (
        `Create a Random Forest machine learning panel for sensing voltage ` +
        `on the dashboard with UID = ${dashboardUid}.`
    );
}

export function extractAlertRuleUidFromReply(reply: string, ruleTitle: string): string | undefined {
    const escaped = ruleTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = reply.match(new RegExp(`${escaped}[^\\n]*?\\(\`?([A-Za-z0-9_-]{8,})\`?\\)`));
    return match?.[1];
}

/** Default titles from multi-panel create programmatic path (Keysight regression). */
export const E2E_MULTI_PANEL_DEFAULT_TITLES = [
    'Gauge Panel',
    'Time Series Panel',
    'Table Panel',
    'Stat Panel',
] as const;
