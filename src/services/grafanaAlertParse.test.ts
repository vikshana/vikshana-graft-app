import {
    formatGrafanaAlertGuidanceReply,
    messageMentionsGrafanaAlertCreate,
    parseGrafanaAlertCreateRequest,
} from './grafanaAlertParse';
import { parseAddOwnHistoryPanelRequest } from './ownHistoryPanelParse';
import { userWantsDashboardReviewOnly } from './dashboardReviewParse';
import { messageHasProgrammaticHandler } from './programmaticChatIntents';

describe('grafanaAlertParse', () => {
    const OWN_HISTORY_ALERT_PROMPT =
        'Create a Grafana alert for the panel titled "Module 2 Current — Alert Test Own History ±2σ" on the dashboard with UID afq7tc6hl1m9sb. Configure the alert to trigger when the Module 2 Actual value is greater than the Upper Bound (±2σ) or less than the Lower Bound (±2σ). Use the existing queries in the panel and notify the Alex Test Email contact point.';

    const MANAGED_RULE_PROMPT =
        'Create a Grafana-managed alert rule for the panel titled "Module 2 Current — Alert Test Own History ±2σ" on the dashboard with UID = afq7tc6hl1m9sb. The alert should: Reduce the Actual, Upper Bound, and Lower Bound queries using the Last value. Trigger when Actual > Upper Bound OR Actual < Lower Bound. Evaluate every minute. Require the condition to be true for one minute. Send notifications to Alex Test Email.';

    const PANEL_CREATE_WITH_ALERT_TEST_TITLE =
        'Create a new time series panel titled "Module 1 Current — Alert Test Own History ±2σ" on the dashboard with UID = afq7tc6hl1m9sb. Create four visible lines: Module 1 Actual = the current value over time Historical Mean = average of Module1_Current_A Upper Bound = Historical Mean + 2 × Standard Deviation Lower Bound = Historical Mean - 2 × Standard Deviation Make sure the Upper Bound and Lower Bound are calculated in the Flux query itself, not only in the legend or panel name.';

    it('detects the failed Own History alert prompt', () => {
        expect(messageMentionsGrafanaAlertCreate(OWN_HISTORY_ALERT_PROMPT)).toBe(true);
        const req = parseGrafanaAlertCreateRequest(OWN_HISTORY_ALERT_PROMPT);
        expect(req?.dashboardUid).toBe('afq7tc6hl1m9sb');
        expect(req?.panelTitle).toBe('Module 2 Current — Alert Test Own History ±2σ');
        expect(req?.contactPoint).toBe('Alex Test Email');
        expect(req?.conditionSummary).toMatch(/Actual > Upper Bound/i);
    });

    it('detects the failed Grafana-managed alert rule prompt', () => {
        expect(messageMentionsGrafanaAlertCreate(MANAGED_RULE_PROMPT)).toBe(true);
        const req = parseGrafanaAlertCreateRequest(MANAGED_RULE_PROMPT);
        expect(req?.dashboardUid).toBe('afq7tc6hl1m9sb');
        expect(req?.panelTitle).toBe('Module 2 Current — Alert Test Own History ±2σ');
        expect(req?.contactPoint).toBe('Alex Test Email');
        expect(req?.every).toBe('1m');
        expect(req?.pendingFor).toBe('1m');
    });

    it('does not treat Alert Test Own History panel create as alert rule create', () => {
        expect(messageMentionsGrafanaAlertCreate(PANEL_CREATE_WITH_ALERT_TEST_TITLE)).toBe(false);
        expect(parseGrafanaAlertCreateRequest(PANEL_CREATE_WITH_ALERT_TEST_TITLE)).toBeNull();
        expect(parseAddOwnHistoryPanelRequest(PANEL_CREATE_WITH_ALERT_TEST_TITLE)?.moduleNumber).toBe(1);
    });

    it('does not misroute either alert prompt to own-history or dashboard review', () => {
        expect(parseAddOwnHistoryPanelRequest(OWN_HISTORY_ALERT_PROMPT)).toBeNull();
        expect(parseAddOwnHistoryPanelRequest(MANAGED_RULE_PROMPT)).toBeNull();
        expect(userWantsDashboardReviewOnly(OWN_HISTORY_ALERT_PROMPT)).toBe(false);
        expect(userWantsDashboardReviewOnly(MANAGED_RULE_PROMPT)).toBe(false);
        expect(messageHasProgrammaticHandler(OWN_HISTORY_ALERT_PROMPT)).toBe(true);
        expect(messageHasProgrammaticHandler(MANAGED_RULE_PROMPT)).toBe(true);
    });

    it('formats guidance that names the contact point and Reduce/Math steps', () => {
        const reply = formatGrafanaAlertGuidanceReply(
            parseGrafanaAlertCreateRequest(MANAGED_RULE_PROMPT)!,
            186,
            'contact point missing'
        );
        expect(reply).toContain('Grafana alerts — how to create this (build 186)');
        expect(reply).toContain('Automatic create failed');
        expect(reply).toContain('Alex Test Email');
        expect(reply).toContain('Module 2 Current — Alert Test Own History ±2σ');
        expect(reply).toContain('afq7tc6hl1m9sb');
        expect(reply).toContain('Reduce');
        expect(reply).toContain('$E > $F || $E < $G');
        expect(reply).toContain('1m');
    });
});
