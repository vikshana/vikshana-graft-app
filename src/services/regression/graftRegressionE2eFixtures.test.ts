import { KEYSIGHT_DASHBOARD_UID } from './graftRegressionFixtures';
import {
    e2eDashboardUid,
    e2ePanelCreatePrompt,
    SANDBOX_E2E_DASHBOARD_UID,
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
