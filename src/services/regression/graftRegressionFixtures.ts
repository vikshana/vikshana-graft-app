import type { LlmIntentKind } from '../llmIntentRouter';

/** Historical Graft operator failure — one row per production incident. */
export type RegressionHandlerId =
    | 'dashboard-metric-panels'
    | 'panel-rename'
    | 'dashboard-review'
    | 'panel-remove'
    | 'panel-create'
    | 'panel-create-multi'
    | 'dashboard-row-with-panels'
    | 'bulk-gauge-panel-rename'
    | 'ambiguous-graph-clarify'
    | 'unsupported-admin'
    | 'llm-save-guard'
    | 'grafana-alert-create'
    | 'grafana-alert-update'
    | 'peer-band-create'
    | 'history-comparison'
    | 'peer-rf-create'
    | 'history-comparison-clarify'
    | 'intent-route-clarify';

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
    {
        id: 'multi-panel-create-types',
        failure:
            'Multi-type panel create (gauge, time series, table, stat) faked Done success with no panels saved',
        prompt:
            'Create a gauge panel, time series panel, table panel, and stat panel for dashboard with UID = cfo0wckufbdhce.',
        expectHandler: 'panel-create-multi',
        expectProgrammatic: true,
        expectLlmIntent: 'programmatic',
        expectReplyContains: ['Panels created', 'Gauge Panel', 'Time Series Panel', 'Table Panel', 'Stat Panel'],
        expectReplyNotContains: ['### Done (panel fix)', '### Done (dashboard saved)'],
    },
    {
        id: 'dashboard-row-with-panels',
        failure: 'Row + panels create faked Done (panel added) with failed-plugin panels',
        prompt:
            'Create a dashboard row called "Machine Health" and add two panels to it for dashboard with UID = cfo0wckufbdhce.',
        expectHandler: 'dashboard-row-with-panels',
        expectProgrammatic: true,
        expectLlmIntent: 'programmatic',
        expectReplyContains: ['Row and panels created', 'Machine Health'],
        expectReplyNotContains: ['### Done (panel added)', 'new panel'],
    },
    {
        id: 'bulk-gauge-panel-rename',
        failure: 'Bulk gauge panel rename routed to dashboard rename (begin label)',
        prompt:
            'Rename all gauge panels to begin with "System" for dashboard with UID = cfo0wckufbdhce.',
        expectHandler: 'bulk-gauge-panel-rename',
        expectProgrammatic: true,
        expectLlmIntent: 'programmatic',
        expectReplyContains: ['Gauge panels renamed', 'System'],
        expectReplyNotContains: ['Could not rename dashboard', 'Dashboard renamed'],
    },
    {
        id: 'ambiguous-graphs-keysight',
        failure:
            'Vague "create useful graphs" LLM path claimed panels saved but none appeared on dashboard',
        prompt:
            'Create graphs that would be useful for the Keysight machine on the dashboard with UID = cfo0wckufbdhce.',
        expectHandler: 'ambiguous-graph-clarify',
        expectProgrammatic: false,
        expectLlmIntent: 'mutating',
        expectReplyContains: ['Need clarification', 'machine_metrics'],
        expectReplyNotContains: ['### Done (panel added)', 'comprehensive monitoring panels'],
    },
    {
        id: 'create-organization-admin',
        failure:
            'Create-org request let the LLM improvise, then looped on the Continue nudge',
        prompt: 'Create a new organization with the dashboard of an existing system.',
        expectHandler: 'unsupported-admin',
        expectProgrammatic: true,
        expectLlmIntent: 'programmatic',
        expectReplyContains: ['Outside Graft', 'organization', 'clone'],
        expectReplyNotContains: ['Reply **Continue**', 'stopped for confirmation'],
    },
    {
        id: 'add-user-admin',
        failure:
            'Add-user request produced an informational reply that looped 3× on the Continue nudge',
        prompt: 'Add a new user that only has access to Skywater-MN Organization.',
        expectHandler: 'unsupported-admin',
        expectProgrammatic: true,
        expectLlmIntent: 'programmatic',
        expectReplyContains: ['Outside Graft', 'user'],
        expectReplyNotContains: ['Reply **Continue**', 'stopped for confirmation'],
    },
    {
        id: 'alert-create-not-panel-create',
        failure:
            'Grafana-managed alert for an existing Peer Band panel was stolen by panel create ("already exists")',
        prompt:
            'Create a Grafana-managed alert for the panel titled "Module 2 Pressure — Alert Test Peer Band ±2σ" on the dashboard with UID = afq7tc6hl1m9sb. Configure the alert to trigger when the Module 1 Actual value is greater than the Upper Bound (±2σ) or less than the Lower Bound (±2σ). Use Reduce expressions with the Last function. Configure the alert to notify the Alex Test Email contact point.',
        expectHandler: 'grafana-alert-create',
        expectProgrammatic: true,
        expectLlmIntent: 'programmatic',
    },
    {
        id: 'alert-create-peer-rf-module2',
        failure:
            'RandomForest vs Peers alert create dumped Own History UI steps instead of creating (truncated UID GET stub / omitted (Influx) suffix)',
        prompt:
            'Create a Grafana-managed alert for the panel titled "Module 2 Current — RandomForest vs Peers" on the dashboard with UID idHkqdqnk. Inspect the existing panel queries and determine how the RandomForest model identifies anomalous behavior. Use the existing RandomForest anomaly score, prediction, or anomaly classification from the panel as the basis for the alert. Configure the alert to trigger when the RandomForest model identifies Module 2 Current as anomalous compared with its peer modules. The anomalous condition must remain true for longer than 1 minute before the alert fires.Modify the panel queries as needed so they are compatible with Grafana Alerting. Alert queries must return alert-compatible numeric time series and should return only _time and _value where required. Do not retain _field labels if they cause long-series data errors. Use the appropriate Reduce expression with the Last function on the RandomForest model output before evaluating the alert condition. Do not invent an arbitrary RandomForest threshold or fake model output. Use the anomaly threshold or classification already defined by the existing RandomForest panel/model. If the panel does not contain sufficient RandomForest output to determine whether Module 2 is anomalous, explain what is missing instead of creating an invalid alert. Configure the alert to notify the Alex Test Email contact point.',
        expectHandler: 'grafana-alert-create',
        expectProgrammatic: true,
        expectLlmIntent: 'programmatic',
    },
    {
        id: 'alert-update-description-by-panel',
        failure:
            'Change alert description by panel title was mis-routed to LLM dashboard save',
        prompt:
            'Change the alert for the panel titled Module 2 Pressure — Alert Test Peer Band ±2σ on the dashboard with the UID = afq7tc6hl1m9sb to have the description of "Alert on Module 2"',
        expectHandler: 'grafana-alert-update',
        expectProgrammatic: true,
        expectLlmIntent: 'programmatic',
    },
    {
        id: 'alert-update-alarm-titled-that-says',
        failure:
            'Add description to alarm titled … Peer Band … that says … was stolen by Peer Band panel create',
        prompt:
            'Add a description to the alarm titled "Module 2 Pressure — Alert Test Peer Band ±2σ — outside ±2σ" on the dashboard with UID = afq7tc6hl1m9sb that says ". Description for Pressure Panel"',
        expectHandler: 'grafana-alert-update',
        expectProgrammatic: true,
        expectLlmIntent: 'programmatic',
    },
    {
        id: 'peer-band-pressure-create',
        failure: 'Peer Band Pressure create was stolen by History Comparison predictive analytics',
        prompt:
            'Create a new machine learning time series panel titled "Module 2 Pressure — Alert Test Peer Band ±2σ" on the dashboard with UID afq7tc6hl1m9sb. Compare Module 2 Pressure against the average of Modules 1 and 3 through 8. Create four visible lines: Module 2 Actual Peer Mean Upper Peer Bound (Peer Mean + 2 × Standard Deviation) Lower Peer Bound (Peer Mean - 2 × Standard Deviation) Calculate the Upper and Lower Peer Bounds in the Flux query itself.',
        expectHandler: 'peer-band-create',
        expectProgrammatic: true,
        expectLlmIntent: 'programmatic',
    },
    {
        id: 'rf-sensing-voltage-not-module5',
        failure:
            'Random Forest sensing voltage create defaulted to Module 5 Current History Comparison',
        prompt:
            'Create a Random Forest machine learning panel for sensing voltage on the dashboard with UID = afq7tc6hl1m9sb.',
        expectHandler: 'history-comparison',
        expectProgrammatic: true,
        expectLlmIntent: 'programmatic',
    },
    {
        id: 'peer-rf-vs-peers',
        failure: 'RandomForest vs Peers create must not route to History Comparison',
        prompt:
            'Create a RandomForest vs Peers (Influx) machine learning panel for Module 3 Current for the dashboard with UID = afq7tc6hl1m9sb.',
        expectHandler: 'peer-rf-create',
        expectProgrammatic: true,
        expectLlmIntent: 'programmatic',
    },
    {
        id: 'peer-rf-module2-operator-wording',
        failure:
            'Operator Module 2 RandomForest vs Peers prompt (titled panel + peer modules) must route to peer-rf-create, not History Comparison or empty-band success',
        prompt:
            'Create a machine learning panel titled "Module 2 Current — RandomForest vs Peers" on the dashboard with UID afq7tc6hl1m9sb. Compare Module 2 Current against the peer modules using a RandomForest anomaly detection model. Plot the Module 2 Actual values and the RandomForest anomaly score or prediction. If a RandomForest model is not available, explain what additional configuration or data is required instead of creating placeholder queries',
        expectHandler: 'peer-rf-create',
        expectProgrammatic: true,
        expectLlmIntent: 'programmatic',
    },
    {
        id: 'rf-bare-pressure-clarify',
        failure:
            'Random Forest for bare pressure fell through to Module 5 ML guidance instead of clarifying',
        prompt:
            'Create a Random Forest machine learning panel for pressure on the dashboard with UID = afq7tc6hl1m9sb.',
        expectHandler: 'history-comparison-clarify',
        expectProgrammatic: true,
        expectLlmIntent: 'programmatic',
        expectReplyContains: ['Need a clearer Random Forest signal', 'pressure'],
        expectReplyNotContains: ['Module 5 Current — History Comparison'],
    },
    {
        id: 'intent-ambiguous-peer-band-vs-hc',
        failure:
            'Peer mean + Random Forest predictive analytics wording silently picked Peer Band or History Comparison',
        prompt:
            'Create a machine learning panel for Module 2 Pressure on the dashboard with UID = afq7tc6hl1m9sb. ' +
            'Compare Module 2 Pressure against peer mean and Random Forest predictive analytics bands.',
        expectHandler: 'intent-route-clarify',
        expectProgrammatic: true,
        /** LLM tools must stay read-only if the clarify gate is skipped. */
        expectLlmIntent: 'read_only',
        expectReplyContains: ['Need clarification', 'Did you mean', 'Peer Band', 'History Comparison'],
        expectReplyNotContains: [
            'Predictive analytics panel — saved',
            'Peer Band panel — saved',
            '### Done',
        ],
    },
];
