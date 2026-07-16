import {
    formatGrafanaAlertGuidanceReply,
    messageMentionsGrafanaAlertCreate,
    messageMentionsGrafanaAlertUpdate,
    parseGrafanaAlertCreateRequest,
    parseGrafanaAlertUpdateRequest,
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

    const CREATE_CONTACT_POINT_PROMPT =
        'Create a Grafana-managed alert for the panel titled "Module 1 Current — Alert Test Own History ±2σ" on the dashboard with UID = idHkqdqnk. Configure the alert to trigger when Module 1 Actual is greater than Upper Bound (±2σ) or less than Lower Bound (±2σ). The condition must remain true for longer than 1 minute before the alert fires. Modify the panel queries as needed so they are compatible with Grafana Alerting. The alert queries must return only _time and _value. Do not include _field in the final alert queries. Use Reduce expressions with the Last function for Actual, Upper Bound, and Lower Bound. Then create a Math expression that evaluates: $Actual > $UpperBound || $Actual < $LowerBound. Create a new email contact point named Alex Test Email using this email address: alex.perry@electramet.com. Configure the alert notification policy so this alert sends notifications to the Alex Test Email contact point.';

    const FULL_CUSTOM_METADATA_PROMPT =
        'Create a Grafana-managed alert named GraftAI Rule for the panel titled "Module 1 Current — Alert Test Own History ±2σ" on the dashboard with UID = idHkqdqnk. Configure the alert to trigger when Module 1 Actual is greater than Upper Bound (±2σ) or less than Lower Bound (±2σ). The condition must remain true for longer than 1 minute before the alert fires. Modify the panel queries as needed so they are compatible with Grafana Alerting. The alert queries must return only _time and _value. Do not include _field in the final alert queries. Use Reduce expressions with the Last function for Actual, Upper Bound, and Lower Bound. Then create a Math expression that evaluates: $Actual > $UpperBound || $Actual < $LowerBound. Create a new email contact point named Alex Test Email using this email address: alex.perry@electramet.com. Configure the alert notification policy so this alert sends notifications to the Alex Test Email contact point. Create an Evaluation Group named GraftAI Alert Groups that evaluates every five minutes. Store the rule in a new folder called GraftAI Alert Tests. Add a label with a key of GraftAI Labels and a value of Alex. Make the summary "Module 1 Current Out of Bounds" and the description "Module 1 Actual Value is Outside the Own History". Add a custom annotation name of "Custom Annotation Name" and content of "Custom Annotation Content".';

    it('parses the create-contact-point alert prompt with email + name', () => {
        const req = parseGrafanaAlertCreateRequest(CREATE_CONTACT_POINT_PROMPT);
        expect(req?.dashboardUid).toBe('idHkqdqnk');
        expect(req?.panelTitle).toBe('Module 1 Current — Alert Test Own History ±2σ');
        expect(req?.contactPoint).toBe('Alex Test Email');
        expect(req?.contactPointEmail).toBe('alex.perry@electramet.com');
        expect(req?.createContactPoint).toBe(true);
        expect(req?.pendingFor).toBe('1m');
    });

    it('parses custom rule name, folder, eval group, labels, and annotations', () => {
        const req = parseGrafanaAlertCreateRequest(FULL_CUSTOM_METADATA_PROMPT);
        expect(req?.ruleTitle).toBe('GraftAI Rule');
        expect(req?.folderTitle).toBe('GraftAI Alert Tests');
        expect(req?.ruleGroup).toBe('GraftAI Alert Groups');
        expect(req?.every).toBe('5m');
        expect(req?.pendingFor).toBe('1m');
        expect(req?.labels).toEqual({ 'GraftAI Labels': 'Alex' });
        expect(req?.summary).toBe('Module 1 Current Out of Bounds');
        expect(req?.description).toBe('Module 1 Actual Value is Outside the Own History');
        expect(req?.customAnnotations).toEqual({
            'Custom Annotation Name': 'Custom Annotation Content',
        });
        expect(req?.contactPoint).toBe('Alex Test Email');
        expect(req?.contactPointEmail).toBe('alex.perry@electramet.com');
    });

    it('parses the "make no other labels or custom annotations" restriction', () => {
        const restricted = `${FULL_CUSTOM_METADATA_PROMPT} Make no other labels or custom annotations.`;
        const req = parseGrafanaAlertCreateRequest(restricted);
        expect(req?.restrictMetadata).toBe(true);
        expect(req?.labels).toEqual({ 'GraftAI Labels': 'Alex' });
        expect(parseGrafanaAlertCreateRequest(FULL_CUSTOM_METADATA_PROMPT)?.restrictMetadata).toBe(
            false
        );
    });

    const METADATA_UPDATE_PROMPT =
        'Update the alert rule named GraftAI Rule. Add one label: key GraftAI Labels, value Alex. Add summary "Module 1 Current Out of Bounds" and description "Module 1 Actual Value is Outside the Own History". Add custom annotation name "Custom Annotation Name" with content "Custom Annotation Content". Configure the rule to notify the Alex Test Email contact point.';

    it('parses metadata-only update prompts without requiring dashboard UID', () => {
        expect(messageMentionsGrafanaAlertUpdate(METADATA_UPDATE_PROMPT)).toBe(true);
        expect(parseGrafanaAlertCreateRequest(METADATA_UPDATE_PROMPT)).toBeNull();
        const req = parseGrafanaAlertUpdateRequest(METADATA_UPDATE_PROMPT);
        expect(req?.ruleTitle).toBe('GraftAI Rule');
        expect(req?.labels).toEqual({ 'GraftAI Labels': 'Alex' });
        expect(req?.summary).toBe('Module 1 Current Out of Bounds');
        expect(req?.description).toBe('Module 1 Actual Value is Outside the Own History');
        expect(req?.customAnnotations).toEqual({
            'Custom Annotation Name': 'Custom Annotation Content',
        });
        expect(req?.contactPoint).toBe('Alex Test Email');
        expect(messageHasProgrammaticHandler(METADATA_UPDATE_PROMPT)).toBe(true);
        expect(parseAddOwnHistoryPanelRequest(METADATA_UPDATE_PROMPT)).toBeNull();
        expect(userWantsDashboardReviewOnly(METADATA_UPDATE_PROMPT)).toBe(false);
    });

    const EVAL_GROUP_UPDATE_PROMPT =
        'Update the alert rule named GraftAI Rule. Create a new evaluation group called "Test Eval Group" that evaluates every minute. Add GraftAI Rule to the Test Eval Group.';

    it('parses evaluation-group move update prompts', () => {
        expect(messageMentionsGrafanaAlertUpdate(EVAL_GROUP_UPDATE_PROMPT)).toBe(true);
        const req = parseGrafanaAlertUpdateRequest(EVAL_GROUP_UPDATE_PROMPT);
        expect(req?.ruleTitle).toBe('GraftAI Rule');
        expect(req?.ruleGroup).toBe('Test Eval Group');
        expect(req?.every).toBe('1m');
        expect(parseGrafanaAlertCreateRequest(EVAL_GROUP_UPDATE_PROMPT)).toBeNull();
    });

    it('does not treat full create prompts as update-only', () => {
        expect(messageMentionsGrafanaAlertUpdate(FULL_CUSTOM_METADATA_PROMPT)).toBe(false);
        expect(parseGrafanaAlertUpdateRequest(FULL_CUSTOM_METADATA_PROMPT)).toBeNull();
        expect(parseGrafanaAlertCreateRequest(FULL_CUSTOM_METADATA_PROMPT)?.panelTitle).toBeTruthy();
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
