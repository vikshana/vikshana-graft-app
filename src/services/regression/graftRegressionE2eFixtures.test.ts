import { parseGrafanaAlertCreateRequest, parseGrafanaAlertUpdateRequest } from '../grafanaAlertParse';
import { parseAddPeerRfPanelRequest } from '../peerRfPanelAddParse';
import { parseCloneIntentMessage } from '../dashboardCloneParse';
import { parseAddPeerBandPanelRequest } from '../peerBandPanelAddParse';
import { parseAddHistoryComparisonPanelRequest } from '../historyComparisonPanelAddParse';
import { parseAddOwnHistoryPanelRequest } from '../ownHistoryPanelParse';
import { KEYSIGHT_DASHBOARD_UID } from './graftRegressionFixtures';
import {
    e2eDashboardClonePrompt,
    e2eDashboardUid,
    e2eGrafanaAlertCreatePrompt,
    e2eGrafanaAlertUpdatePrompt,
    e2ePanelCreatePrompt,
    e2ePeerBandPressureCreatePrompt,
    e2ePeerBandAlertCreatePrompt,
    e2ePeerBandAlertUpdateByRulePrompt,
    E2E_PEER_BAND_ALERT_PANEL_TITLE,
    E2E_PEER_BAND_ALERT_RULE_TITLE,
    e2ePeerRfPanelCreatePrompt,
    e2ePeerRfVsPeersPrompt,
    e2eSensingVoltageHistoryComparisonPrompt,
    e2eOwnHistorySensingVoltagePrompt,
    e2eModule1AnomalyHistoryComparisonPrompt,
    e2eAmbiguousPeerBandVsHistoryComparisonPrompt,
    extractAlertRuleUidFromReply,
    extractClonedDashboardUidFromReply,
    E2E_CLONE_SOURCE_MACHINE,
    E2E_CLONE_TARGET_MACHINE,
    E2E_CLONE_SOURCE_DASHBOARD_UID,
    SANDBOX_E2E_DASHBOARD_UID,
    SANDBOX_SKYWATER_DASHBOARD_UID,
} from './graftRegressionE2eFixtures';
import { resolveIntentRouteAmbiguity } from '../programmaticIntentRouter';

describe('e2eDashboardUid', () => {
    const previous = process.env.GRAFANA_E2E_DASHBOARD_UID;

    afterEach(() => {
        if (previous === undefined) {
            delete process.env.GRAFANA_E2E_DASHBOARD_UID;
        } else {
            process.env.GRAFANA_E2E_DASHBOARD_UID = previous;
        }
    });

    it('defaults Playwright to the sandbox E2E clone, not the historical Jest Keysight UID', () => {
        delete process.env.GRAFANA_E2E_DASHBOARD_UID;
        expect(SANDBOX_E2E_DASHBOARD_UID).toBe('grafte2ekeysht');
        expect(e2eDashboardUid()).toBe(SANDBOX_E2E_DASHBOARD_UID);
        expect(e2eDashboardUid()).not.toBe(KEYSIGHT_DASHBOARD_UID);
        expect(e2ePanelCreatePrompt('Cartridge Comparison')).toContain(SANDBOX_E2E_DASHBOARD_UID);
        expect(e2ePanelCreatePrompt('Cartridge Comparison')).not.toContain(KEYSIGHT_DASHBOARD_UID);
    });

    it('honors GRAFANA_E2E_DASHBOARD_UID when set', () => {
        process.env.GRAFANA_E2E_DASHBOARD_UID = 'afq7tc6hl1m9sb';
        expect(e2eDashboardUid()).toBe('afq7tc6hl1m9sb');
    });
});

describe('e2eGrafanaAlertCreatePrompt', () => {
    it('parses as programmatic RF alert create on the sandbox E2E Keysight clone', () => {
        const ruleTitle = 'Graft E2E RF 123';
        const req = parseGrafanaAlertCreateRequest(e2eGrafanaAlertCreatePrompt(ruleTitle));
        expect(req).toMatchObject({
            dashboardUid: SANDBOX_E2E_DASHBOARD_UID,
            panelTitle: 'Module 2 Current — RandomForest vs Peers (Influx)',
            ruleTitle,
            contactPoint: 'Alex Test Email',
        });
        expect(req?.dashboardUid).not.toBe(KEYSIGHT_DASHBOARD_UID);
        expect(req?.dashboardUid).not.toBe(SANDBOX_SKYWATER_DASHBOARD_UID);
    });

    it('parses an E2E alert-update prompt by panel title', () => {
        const req = parseGrafanaAlertUpdateRequest(
            e2eGrafanaAlertUpdatePrompt('Graft E2E RF vs Peers', 'Graft E2E sandbox description')
        );
        expect(req?.ruleTitle).toBe('Graft E2E RF vs Peers');
        expect(req?.dashboardUid).toBe(SANDBOX_E2E_DASHBOARD_UID);
        expect(req?.description).toBe('Graft E2E sandbox description');
    });

    it('parses peer-RF create onto the sandbox E2E Keysight clone', () => {
        const title = 'Module 2 Current — RandomForest vs Peers E2E 1';
        const req = parseAddPeerRfPanelRequest(e2ePeerRfPanelCreatePrompt(title));
        expect(req?.dashboardUid).toBe(SANDBOX_E2E_DASHBOARD_UID);
        expect(req?.moduleNumber).toBe(2);
    });

    it('extracts the provisioned rule uid from a Graft create reply', () => {
        const title = 'Graft E2E RF 123';
        const reply =
            `### Grafana alert created (build 216)\n\n` +
            `**Saved from panel** — rule **${title}** (\`cfvoxf1zoqr5sa\`).\n\n` +
            `- **Dashboard:** 2103-176030 / Skywater-MN (\`idHkqdqnk\`)`;
        expect(extractAlertRuleUidFromReply(reply, title)).toBe('cfvoxf1zoqr5sa');
        const rendered = `Saved from panel — rule ${title} (cfvoxf1zoqr5sa).\nDashboard: Skywater-MN (idHkqdqnk)`;
        expect(extractAlertRuleUidFromReply(rendered, title)).toBe('cfvoxf1zoqr5sa');
    });

    it('parses a one-dashboard clone between unused sandbox machine ids', () => {
        const title = `${E2E_CLONE_TARGET_MACHINE} / Graft E2E Clone 1`;
        const parsed = parseCloneIntentMessage(e2eDashboardClonePrompt(title));
        expect(parsed.valid).toBe(true);
        expect(parsed.sourceMachineId).toBe(E2E_CLONE_SOURCE_MACHINE);
        expect(parsed.targetMachineId).toBe(E2E_CLONE_TARGET_MACHINE);
        expect(parsed.requestedTitle).toBe(title);
        expect(extractClonedDashboardUidFromReply(
            '**New dashboard:** 2599-000001 / Graft E2E Clone (`abcdef12`).\n- **Panels copied:** 1'
        )).toBe('abcdef12');
    });

    it('parses peer-band pressure create onto the sandbox E2E Keysight clone', () => {
        const title = 'Module 2 Pressure — Alert Test Peer Band ±2σ E2E 1';
        const req = parseAddPeerBandPanelRequest(e2ePeerBandPressureCreatePrompt(title));
        expect(req?.dashboardUid).toBe(SANDBOX_E2E_DASHBOARD_UID);
        expect(req?.metricKind).toBe('pressure');
        expect(req?.moduleNumber).toBe(2);
        expect(req?.panelTitle).toBe(title);
    });

    it('parses peer-band alert create on the sandbox E2E Keysight clone', () => {
        const req = parseGrafanaAlertCreateRequest(e2ePeerBandAlertCreatePrompt());
        expect(req?.dashboardUid).toBe(SANDBOX_E2E_DASHBOARD_UID);
        expect(req?.panelTitle).toBe(E2E_PEER_BAND_ALERT_PANEL_TITLE);
        expect(req?.contactPoint).toBe('Alex Test Email');
    });

    it('parses peer-band alert update by rule title on the sandbox E2E Keysight clone', () => {
        const req = parseGrafanaAlertUpdateRequest(
            e2ePeerBandAlertUpdateByRulePrompt('. Description for Pressure Panel')
        );
        expect(req?.dashboardUid).toBe(SANDBOX_E2E_DASHBOARD_UID);
        expect(req?.ruleTitle).toBe(E2E_PEER_BAND_ALERT_RULE_TITLE);
    });

    it('parses peer-RF vs Peers create onto the sandbox E2E Keysight clone', () => {
        const req = parseAddPeerRfPanelRequest(e2ePeerRfVsPeersPrompt());
        expect(req?.dashboardUid).toBe(SANDBOX_E2E_DASHBOARD_UID);
        expect(req?.moduleNumber).toBe(3);
    });

    it('parses own-history Sensing Voltage onto the sandbox E2E Keysight clone', () => {
        const req = parseAddOwnHistoryPanelRequest(
            e2eOwnHistorySensingVoltagePrompt(SANDBOX_E2E_DASHBOARD_UID)
        );
        expect(req?.dashboardUid).toBe(SANDBOX_E2E_DASHBOARD_UID);
        expect(req?.metricLabel?.toLowerCase()).toMatch(/sensing voltage/);
    });

    it('parses Module 1 ML/anomaly detection as History Comparison onto the sandbox E2E Keysight clone', () => {
        const req = parseAddHistoryComparisonPanelRequest(
            e2eModule1AnomalyHistoryComparisonPrompt(SANDBOX_E2E_DASHBOARD_UID)
        );
        expect(req?.dashboardUid).toBe(SANDBOX_E2E_DASHBOARD_UID);
        expect(req?.moduleNumber).toBe(1);
        expect(req?.signal?.field).toBe('Module1_Current_A');
    });

    it('parses sensing-voltage History Comparison onto a cloned dashboard uid', () => {
        const req = parseAddHistoryComparisonPanelRequest(
            e2eSensingVoltageHistoryComparisonPrompt('grafte2eclone')
        );
        expect(req?.dashboardUid).toBe('grafte2eclone');
        expect(req?.dashboardUid).not.toBe(E2E_CLONE_SOURCE_DASHBOARD_UID);
        expect(req?.signal?.field).toBe('Cartridge_Sensing_Voltage');
        expect(req?.signal?.panelTitle).toMatch(/Sensing Voltage/i);
    });

    it('routes ambiguous peer-mean + RF predictive wording to did-you-mean clarification', () => {
        const prompt = e2eAmbiguousPeerBandVsHistoryComparisonPrompt();
        const reply = resolveIntentRouteAmbiguity(prompt, 216);
        expect(reply).toMatch(/Need clarification/i);
        expect(reply).toMatch(/Did you mean/i);
        expect(reply).toMatch(/Peer Band/i);
        expect(reply).toMatch(/History Comparison/i);
        // Peer Band parser still matches — ChatInterface must run resolveIntentRouteAmbiguity first.
        expect(parseAddPeerBandPanelRequest(prompt)).not.toBeNull();
        expect(parseAddHistoryComparisonPanelRequest(prompt)).toBeNull();
    });
});
