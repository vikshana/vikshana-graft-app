import { parseInfluxPanelRepairRequest, messageMentionsInfluxPanelRepair } from './influxPanelRepairParse';

describe('influxPanelRepairParse', () => {
    const prompt =
        'in dashboard named "2406-176021 / Exsolve". name in "Module 5 Current — RandomForest ML (Influx)" fix panel json. ' +
        'Status: 400 parse error: unexpected identifier "v"';

    it('detects Flux-on-Prometheus repair intent', () => {
        expect(messageMentionsInfluxPanelRepair(prompt)).toBe(true);
        const req = parseInfluxPanelRepairRequest(prompt);
        expect(req?.dashboardTitle).toBe('2406-176021 / Exsolve');
        expect(req?.machineId).toBe('2406-176021');
        expect(req?.panelTitle).toContain('RandomForest');
    });
});
