import { parseGrafanaAlertCreateRequest } from '../grafanaAlertParse';
import { KEYSIGHT_DASHBOARD_UID } from './graftRegressionFixtures';
import {
    e2eDashboardUid,
    e2eGrafanaAlertCreatePrompt,
    e2ePanelCreatePrompt,
    extractAlertRuleUidFromReply,
    SANDBOX_E2E_DASHBOARD_UID,
    SANDBOX_SKYWATER_DASHBOARD_UID,
} from './graftRegressionE2eFixtures';

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
    it('parses as programmatic RF alert create on sandbox Skywater, not Keysight', () => {
        const ruleTitle = 'Graft E2E RF 123';
        const req = parseGrafanaAlertCreateRequest(e2eGrafanaAlertCreatePrompt(ruleTitle));
        expect(req).toMatchObject({
            dashboardUid: SANDBOX_SKYWATER_DASHBOARD_UID,
            panelTitle: 'Module 2 Current — RandomForest vs Peers',
            ruleTitle,
            contactPoint: 'Alex Test Email',
        });
        expect(req?.dashboardUid).not.toBe(KEYSIGHT_DASHBOARD_UID);
        expect(req?.dashboardUid).not.toBe(SANDBOX_E2E_DASHBOARD_UID);
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
});
