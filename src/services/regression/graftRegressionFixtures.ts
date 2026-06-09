import type { LlmIntentKind } from '../llmIntentRouter';

/** Historical Graft operator failure — one row per production incident. */
export type RegressionHandlerId =
    | 'dashboard-metric-panels'
    | 'panel-rename'
    | 'dashboard-review'
    | 'panel-remove'
    | 'panel-create'
    | 'llm-save-guard';

export interface RegressionCase {
    id: string;
    /** What went wrong in production */
    failure: string;
    /** Exact or near-exact user prompt from operator chat */
    prompt: string;
    expectHandler: RegressionHandlerId;
    /** messageHasProgrammaticHandler */
    expectProgrammatic: boolean;
    expectLlmIntent: LlmIntentKind;
    /** Prior dashboard UID from chat context */
    contextDashboardUid?: string;
    expectReplyContains?: string[];
    expectReplyNotContains?: string[];
}

export const KEYSIGHT_DASHBOARD_UID = 'cfo0wckufbdhce';

export const REGRESSION_CASES: RegressionCase[] = [
    {
        id: 'bulk-metric-panels',
        failure:
            'Keysight bulk panels used standalone metric names instead of machine_metrics{field="..."}',
        prompt:
            'Create 50 panels covering every available metric on the dashboard with UID = cfo0wckufbdhce',
        expectHandler: 'dashboard-metric-panels',
        expectProgrammatic: true,
        expectLlmIntent: 'programmatic',
    },
    {
        id: 'panel-rename-not-dashboard',
        failure:
            'Panel rename routed to dashboard rename; LLM replied Done (dashboard saved) instead of programmatic panel rename',
        prompt:
            'Rename the "Pressure Gauge" panel to "System Pressure" on dashboard UID = cfo0wckufbdhce.',
        expectHandler: 'panel-rename',
        expectProgrammatic: true,
        expectLlmIntent: 'programmatic',
        expectReplyContains: ['Panel renamed'],
        expectReplyNotContains: ['### Done (dashboard saved)', 'Dashboard renamed'],
    },
    {
        id: 'dashboard-review-suggest-only',
        failure: 'Dashboard review entered save/continue loop instead of suggest-only programmatic review',
        prompt:
            'Review dashboard with UID = cfo0wckufbdhce and suggest three improvements to improve readability.',
        expectHandler: 'dashboard-review',
        expectProgrammatic: true,
        expectLlmIntent: 'programmatic',
        expectReplyContains: ['readability suggestions'],
        expectReplyNotContains: [
            'would you like',
            'reply continue',
            'apply these',
            '### Done (dashboard saved)',
        ],
    },
    {
        id: 'panel-remove-verify',
        failure: 'Panel remove claimed success without post-save verification',
        prompt: 'remove the Cartridge Happiness Panel',
        expectHandler: 'panel-remove',
        expectProgrammatic: true,
        expectLlmIntent: 'programmatic',
        contextDashboardUid: KEYSIGHT_DASHBOARD_UID,
        expectReplyContains: ['Panel removed'],
        expectReplyNotContains: ['### Done (dashboard saved)'],
    },
    {
        id: 'llm-save-read-only-guard',
        failure: 'Read-only / review turns still called update_dashboard or faked save success',
        prompt:
            'Review dashboard with UID = cfo0wckufbdhce and suggest three improvements to improve readability.',
        expectHandler: 'llm-save-guard',
        expectProgrammatic: true,
        expectLlmIntent: 'programmatic',
    },
    {
        id: 'panel-create-bar-chart',
        failure:
            'Bar chart panel create faked success with Done (panel fix) instead of programmatic create + verify',
        prompt: 'Create a bar chart panel called "Cartridge Comparison" for Keysight.',
        expectHandler: 'panel-create',
        expectProgrammatic: true,
        expectLlmIntent: 'programmatic',
        expectReplyContains: ['Panel created', 'Cartridge Comparison'],
        expectReplyNotContains: ['### Done (panel fix)'],
    },
    {
        id: 'review-no-auto-continue',
        failure: 'Numbered review suggestions triggered Continue auto-loop',
        prompt:
            'Review dashboard with UID = cfo0wckufbdhce and suggest three improvements to improve readability.',
        expectHandler: 'dashboard-review',
        expectProgrammatic: true,
        expectLlmIntent: 'programmatic',
    },
];
