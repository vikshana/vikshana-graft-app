/**
 * Exact operator prompts from "Graft AI Assistant Write-Up.pdf", filled with
 * sandbox machine ids / uids. Mutating jobs must decide or ask — not LLM-fake Done.
 */
import { parseCloneIntentMessage } from '../dashboardCloneParse';
import { userWantsDashboardClone } from '../dashboardCloneProgress';
import {
    parseDashboardRenameRequest,
    userWantsDashboardRename,
} from '../dashboardRenameParse';
import { parsePanelRenameRequest, userWantsPanelRename } from '../panelRenameParse';
import {
    messageMentionsOwnHistoryPanel,
    parseAddOwnHistoryPanelRequest,
} from '../ownHistoryPanelParse';
import {
    messageMentionsPredictiveAnalyticsPanel,
    parseAddHistoryComparisonPanelRequest,
} from '../historyComparisonPanelAddParse';
import {
    messageMentionsAddPeerRfPanel,
    parseAddPeerRfPanelRequest,
} from '../peerRfPanelAddParse';
import {
    messageMentionsPeerBandPanelCreate,
    parseAddPeerBandPanelRequest,
} from '../peerBandPanelAddParse';
import { messageMentionsGrafanaAlertCreate, parseGrafanaAlertCreateRequest } from '../grafanaAlertParse';
import { messageDescribesPanelCreate, parsePanelCreateRequest } from '../panelCreateParse';
import { messageHasProgrammaticHandler } from '../programmaticChatIntents';
import { formatClarificationIfNeeded } from '../requestClarity';
import { classifyLlmIntent } from '../llmIntentRouter';

const UID = 'idHkqdqnk';
const TARGET = '2505-200033';
const SOURCE = '2103-176030';

function handleOrAsk(prompt: string): boolean {
    return messageHasProgrammaticHandler(prompt) || Boolean(formatClarificationIfNeeded(prompt));
}

const CLONE_SHORT = `Clone dashboard ${SOURCE} and rename it to ${TARGET}`;
const CLONE_DOC = `I have a machine from Keysight for ${TARGET}. Create a dashboard for it that is a copy of ${SOURCE}, but with data for ${TARGET}.`;
const CLONE_FIVE = 'Create the dashboard 5 panels at a time.';
const RENAME_DASH = `Rename the dashboard for the ${TARGET} machine to be Keysight instead of the current name.`;
const RENAME_DASH_UID = `Rename the dashboard for the 6sFerv44k machine to be NewSkywater-FL instead of the current name.`;
const GAUGE = `Add a gauge panel called "Pressure Monitoring" on the dashboard with UID = ${UID}.`;
const BAR = `Create a bar chart to show the Sensing Voltage for Cartridges on the dashboard with UID = ${UID}.`;
const RENAME_PANEL = `Rename the "Current" panel on ${TARGET} / Keysight to be "NewCurrent."`;
const RENAME_PANEL_UID = `Rename the "Current" panel on the dashboard with UID = ${UID} to be "NewCurrent."`;
const LIST = `List all panels currently in the dashboard with UID="${UID}"`;
const SUMMARIZE = `Summarize the purpose of the dashboard with UID = "${UID}"`;
const MISSING = `Review the dashboard with uid="${UID}" and identify any missing panels.`;
const EXPLAIN_ML = 'Explain the purpose of the machine learning panels on this dashboard';
const ML_OWN_HISTORY_MODULE4 =
    'Create a machine learning panel for Module 4 Current that compares the current trend against its own history';
const ML_HISTORICAL =
    'Create a machine learning panel that compares Sensing Voltage against its historical values';
const ML_OWN_HISTORY_DOC =
    'Create a machine learning panel that compares Sensing Voltage against its own history';
const PEER_AVG =
    'Create a machine learning panel that compares Module 1 Current against the average of Modules 2–8.';
const PEER_BAND =
    'Create a machine learning panel that compares Module 2 Current against its Peer Band.';
const RF = 'Create a RandomForest vs Peers panel for Module 2 Current.';
const RF_UID = `Create a RandomForest vs Peers panel for Module 2 Current on the dashboard with UID = ${UID}.`;
const PRESSURE_OWN_HISTORY = `Create a vs. Own History (±2σ) machine learning panel for Pressure on the dashboard with UID = ${UID}.`;
const COPY_PANEL =
    'Make a new panel on the 2505-200033 / Keysight dashboard that is a copy of the "Total Cu Mass" panel on 2406-176021 / Exsolve';
const MODIFY_PANEL = `Change the "Pressure" panel on the dashboard with UID = ${UID} to a time series.`;
const THRESHOLDS = `Set the thresholds on the Pressure graph on the dashboard with UID = ${UID} to 10 and 80.`;
const DESCRIPTION = `Write a description for the dashboard with UID = ${UID}.`;
const REORG = `Move the Sensing Voltage panel below Module 1 Current on the dashboard with UID = ${UID}.`;

const ALERT_OWN_HISTORY = `Create a Grafana-managed alert for the panel titled "Module 1 Current — Alert Test Own History ±2σ" on the dashboard with UID = ${UID}. Configure the alert to trigger when the Module 1 Actual value is greater than the Upper Bound (±2σ) or less than the Lower Bound (±2σ).
Modify the panel queries as needed so they are compatible with Grafana Alerting. The alert queries should return alert-compatible numeric time series (not long-series data with _field labels).
Use Reduce expressions with the Last function for the Actual, Upper Bound, and Lower Bound queries, then create a Math expression that evaluates: Actual > Upper Bound OR Actual < Lower Bound.
Configure the alert to notify the Alex Test Email contact point.`;

const ALERT_OWN_HISTORY_NEW_CONTACT = `Create a Grafana-managed alert for the panel titled "Module 1 Current — Alert Test Own History ±2σ" on the dashboard with UID = ${UID}. Configure the alert to trigger when Module 1 Actual is greater than Upper Bound (±2σ) or less than Lower Bound (±2σ).
The condition must remain true for longer than 1 minute before the alert fires. Modify the panel queries as needed so they are compatible with Grafana Alerting. The alert queries must return only _time and _value. Do not include _field in the final alert queries.
Use Reduce expressions with the Last function for Actual, Upper Bound, and Lower Bound. Then create a Math expression that evaluates: $Actual > $UpperBound || $Actual < $LowerBound.
Create a new email contact point named Alex Test Email using this email address: alex.perry@electramet.com. Configure the alert notification policy so this alert sends notifications to the Alex Test Email contact point.`;

const ALERT_PEER_BAND = `Create a Grafana-managed alert for the panel titled "Module 2 Pressure — Alert Test Peer Band ±2σ" on the dashboard with UID = afq7tc6hl1m9sb. Configure the alert to trigger when the Module 1 Actual value is greater than the Upper Bound (±2σ) or less than the Lower Bound (±2σ).
Modify the panel queries as needed so they are compatible with Grafana Alerting. The alert queries should return alert-compatible numeric time series (not long-series data with _field labels).
Use Reduce expressions with the Last function for the Actual, Upper Bound, and Lower Bound queries, then create a Math expression that evaluates: Actual > Upper Bound OR Actual < Lower Bound.
Configure the alert to notify the Alex Test Email contact point.`;

const ALERT_RF = `Create a Grafana-managed alert for the panel titled "Module 2 Current — RandomForest vs Peers" on the dashboard with UID ${UID}. Inspect the existing panel queries and determine how the RandomForest model identifies anomalous behavior. Use the existing RandomForest anomaly score, prediction, or anomaly classification from the panel as the basis for the alert.
Configure the alert to trigger when the RandomForest model identifies Module 2 Current as anomalous compared with its peer modules. The anomalous condition must remain true for longer than 1 minute before the alert fires.Modify the panel queries as needed so they are compatible with Grafana Alerting. Alert queries must return alert-compatible numeric time series and should return only _time and _value where required. Do not retain _field labels if they cause long-series data errors.
Use the appropriate Reduce expression with the Last function on the RandomForest model output before evaluating the alert condition. Do not invent an arbitrary RandomForest threshold or fake model output. Use the anomaly threshold or classification already defined by the existing RandomForest panel/model. If the panel does not contain sufficient RandomForest output to determine whether Module 2 is anomalous, explain what is missing instead of creating an invalid alert.
Configure the alert to notify the Alex Test Email contact point.`;

describe('write-up PDF — mutating jobs decide or ask', () => {
    it.each([
        ['clone short', CLONE_SHORT],
        ['clone from machine id', CLONE_DOC],
        ['rename dashboard by machine', RENAME_DASH],
        ['rename dashboard by uid-as-machine', RENAME_DASH_UID],
        ['gauge panel', GAUGE],
        ['bar chart sensing voltage', BAR],
        ['rename panel by machine title', RENAME_PANEL],
        ['rename panel by uid', RENAME_PANEL_UID],
        ['ML own history module 4', ML_OWN_HISTORY_MODULE4],
        ['ML historical values', ML_HISTORICAL],
        ['ML own history sensing voltage', ML_OWN_HISTORY_DOC],
        ['peer average modules', PEER_AVG],
        ['peer band', PEER_BAND],
        ['RF vs peers', RF],
        ['RF vs peers with uid', RF_UID],
        ['pressure own history', PRESSURE_OWN_HISTORY],
        ['copy single panel', COPY_PANEL],
        ['alert own history', ALERT_OWN_HISTORY],
        ['alert own history new contact', ALERT_OWN_HISTORY_NEW_CONTACT],
        ['alert peer band', ALERT_PEER_BAND],
        ['alert RF vs peers', ALERT_RF],
    ])('%s', (_label, prompt) => {
        expect(handleOrAsk(prompt)).toBe(true);
    });
});

describe('write-up PDF — clone / rename / panel details', () => {
    it('clone by two machine ids is valid', () => {
        expect(userWantsDashboardClone(CLONE_SHORT)).toBe(true);
        expect(userWantsDashboardClone(CLONE_DOC)).toBe(true);
        const parsed = parseCloneIntentMessage(CLONE_DOC);
        expect(parsed.valid).toBe(true);
        expect(parsed.sourceMachineId).toBe(SOURCE);
        expect(parsed.targetMachineId).toBe(TARGET);
    });

    it('dashboard rename from write-up wording', () => {
        expect(userWantsDashboardRename(RENAME_DASH_UID)).toBe(true);
        expect(parseDashboardRenameRequest(RENAME_DASH_UID)?.newLabel).toBe('NewSkywater-FL');
    });

    it('panel rename from write-up wording', () => {
        expect(userWantsPanelRename(RENAME_PANEL_UID)).toBe(true);
        expect(parsePanelRenameRequest(RENAME_PANEL_UID)?.newPanelTitle).toMatch(/NewCurrent/i);
    });

    it('gauge create is a panel create', () => {
        expect(messageDescribesPanelCreate(GAUGE)).toBe(true);
        expect(parsePanelCreateRequest(GAUGE)).not.toBeNull();
    });

    it('own-history vs historical values vs RF vs peer band stay distinct', () => {
        expect(messageMentionsOwnHistoryPanel(ML_OWN_HISTORY_MODULE4)).toBe(true);
        expect(messageMentionsOwnHistoryPanel(ML_OWN_HISTORY_DOC)).toBe(true);
        expect(messageMentionsOwnHistoryPanel(ML_HISTORICAL)).toBe(true);
        expect(
            parseAddOwnHistoryPanelRequest(ML_OWN_HISTORY_DOC, { contextDashboardUid: UID })?.metricLabel
                ?.toLowerCase()
        ).toMatch(/sensing voltage/);
        expect(
            parseAddOwnHistoryPanelRequest(ML_HISTORICAL, { contextDashboardUid: UID })?.metricLabel
                ?.toLowerCase()
        ).toMatch(/sensing voltage/);
        expect(messageMentionsAddPeerRfPanel(RF_UID)).toBe(true);
        expect(parseAddPeerRfPanelRequest(RF_UID)?.moduleNumber).toBe(2);
        expect(messageMentionsAddPeerRfPanel(PEER_AVG)).toBe(false);
        expect(messageMentionsPeerBandPanelCreate(PEER_BAND) || parseAddPeerBandPanelRequest(PEER_BAND)).toBeTruthy();
        expect(messageMentionsPredictiveAnalyticsPanel(PRESSURE_OWN_HISTORY)).toBe(false);
        expect(parseAddOwnHistoryPanelRequest(PRESSURE_OWN_HISTORY)).not.toBeNull();
    });

    it('write-up Grafana alert prompts parse as alert create, not panel create', () => {
        for (const prompt of [ALERT_OWN_HISTORY, ALERT_OWN_HISTORY_NEW_CONTACT, ALERT_PEER_BAND, ALERT_RF]) {
            expect(messageMentionsGrafanaAlertCreate(prompt)).toBe(true);
            expect(parseGrafanaAlertCreateRequest(prompt)).not.toBeNull();
            expect(parseAddPeerRfPanelRequest(prompt)).toBeNull();
            expect(parseAddOwnHistoryPanelRequest(prompt)).toBeNull();
        }
    });
});

describe('write-up PDF — read-only analysis is not an unmatched job', () => {
    it.each([LIST, SUMMARIZE, MISSING, EXPLAIN_ML, DESCRIPTION])('%s', (prompt) => {
        expect(formatClarificationIfNeeded(prompt)).toBeNull();
        expect(classifyLlmIntent(prompt)).not.toBe('conversational');
    });
});

describe('write-up PDF — jobs that should still ask rather than guess', () => {
    it('batch clone without a template asks', () => {
        expect(handleOrAsk(CLONE_FIVE) || classifyLlmIntent(CLONE_FIVE) !== 'conversational').toBe(true);
    });

    it('modify / threshold / reorg either handle or ask', () => {
        expect(handleOrAsk(MODIFY_PANEL) || classifyLlmIntent(MODIFY_PANEL) !== 'conversational').toBe(true);
        expect(handleOrAsk(THRESHOLDS) || classifyLlmIntent(THRESHOLDS) !== 'conversational').toBe(true);
        expect(handleOrAsk(REORG) || classifyLlmIntent(REORG) !== 'conversational').toBe(true);
    });
});
