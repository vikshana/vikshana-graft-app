import {
    extractPeerModulesFromMessage,
    messageMentionsPeerBandPanelCreate,
    parseAddPeerBandPanelRequest,
    resolvePeerBandMetricFields,
} from './peerBandPanelAddParse';
import { messageDescribesPanelCreate, parsePanelCreateRequest } from './panelCreateParse';
import { parseAddOwnHistoryPanelRequest } from './ownHistoryPanelParse';
import {
    messageMentionsPredictiveAnalyticsPanel,
    parseAddHistoryComparisonPanelRequest,
} from './historyComparisonPanelAddParse';
import { messageHasProgrammaticHandler } from './programmaticChatIntents';
import { buildPeerBandPanel, peerBandQueryUsesUnionTemplate } from './fluxPeerBandFix';

describe('peerBandPanelAddParse', () => {
    const PROMPT =
        'Create a new machine learning time series panel titled "Module 2 Current — Alert Test Peer Band ±2σ" on the dashboard with UID idHkqdqnk. Compare Module 2 Current against the average of Modules 1 and 3 through 8. Create four visible lines: Module 2 Actual Peer Mean Upper Peer Bound (Peer Mean + 2 × Standard Deviation) Lower Peer Bound (Peer Mean - 2 × Standard Deviation) Calculate the Upper and Lower Peer Bounds in the Flux query itself.';

    const PROMPT_KEYSIGHT =
        'Create a new machine learning time series panel titled "Module 2 Current — Alert Test Peer Band ±2σ" on the dashboard with UID afq7tc6hl1m9sb. Compare Module 2 Current against the average of Modules 1 and 3 through 8. Create four visible lines: Module 2 Actual Peer Mean Upper Peer Bound (Peer Mean + 2 × Standard Deviation) Lower Peer Bound (Peer Mean - 2 × Standard Deviation) Calculate the Upper and Lower Peer Bounds in the Flux query itself.';

    const PROMPT_PRESSURE =
        'Create a new machine learning time series panel titled "Module 2 Pressure — Alert Test Peer Band ±2σ" on the dashboard with UID afq7tc6hl1m9sb. Compare Module 2 Pressure against the average of Modules 1 and 3 through 8. Create four visible lines: Module 2 Actual Peer Mean Upper Peer Bound (Peer Mean + 2 × Standard Deviation) Lower Peer Bound (Peer Mean - 2 × Standard Deviation) Calculate the Upper and Lower Peer Bounds in the Flux query itself.';

    it('matches write-up average-of-modules peer compare without the words peer band', () => {
        const prompt =
            'Create a machine learning panel that compares Module 1 Current against the average of Modules 2 through 8 on uid=idHkqdqnk.';
        expect(messageMentionsPeerBandPanelCreate(prompt)).toBe(true);
        expect(parseAddPeerBandPanelRequest(prompt)?.moduleNumber).toBe(1);
    });

    it('parses the Alert Test Peer Band create prompt', () => {
        expect(messageMentionsPeerBandPanelCreate(PROMPT)).toBe(true);
        const req = parseAddPeerBandPanelRequest(PROMPT);
        expect(req).not.toBeNull();
        expect(req?.dashboardUid).toBe('idHkqdqnk');
        expect(req?.moduleNumber).toBe(2);
        expect(req?.panelTitle).toBe('Module 2 Current — Alert Test Peer Band ±2σ');
        expect(req?.peerModules).toEqual([1, 3, 4, 5, 6, 7, 8]);
        expect(req?.metricKind).toBe('current');
    });

    it('parses Pressure peer-band prompts with PressureN_psi fields (not ModuleN_Current_A)', () => {
        const req = parseAddPeerBandPanelRequest(PROMPT_PRESSURE);
        expect(req?.metricKind).toBe('pressure');
        expect(req?.moduleNumber).toBe(2);
        expect(req?.panelTitle).toBe('Module 2 Pressure — Alert Test Peer Band ±2σ');
        const fields = resolvePeerBandMetricFields(2, req!.peerModules!, 'pressure');
        expect(fields.actualField).toBe('Pressure2_psi');
        expect(fields.peerFields).toEqual([
            'Pressure1_psi',
            'Pressure3_psi',
            'Pressure4_psi',
            'Pressure5_psi',
            'Pressure6_psi',
            'Pressure7_psi',
            'Pressure8_psi',
        ]);
        expect(fields.unit).toBe('psi');
        expect(messageMentionsPredictiveAnalyticsPanel(PROMPT_PRESSURE)).toBe(false);
        expect(messageHasProgrammaticHandler(PROMPT_PRESSURE)).toBe(true);
    });

    it('does not route to generic panel create, own-history, or History Comparison', () => {
        for (const prompt of [PROMPT, PROMPT_KEYSIGHT]) {
            expect(messageDescribesPanelCreate(prompt)).toBe(false);
            expect(parsePanelCreateRequest(prompt)).toBeNull();
            expect(parseAddOwnHistoryPanelRequest(prompt)).toBeNull();
            expect(messageMentionsPredictiveAnalyticsPanel(prompt)).toBe(false);
            expect(parseAddHistoryComparisonPanelRequest(prompt)).toBeNull();
            expect(messageHasProgrammaticHandler(prompt)).toBe(true);
            expect(parseAddPeerBandPanelRequest(prompt)?.moduleNumber).toBe(2);
        }
        expect(parseAddPeerBandPanelRequest(PROMPT_KEYSIGHT)?.dashboardUid).toBe('afq7tc6hl1m9sb');
    });

    it('does not steal Grafana-managed alert prompts that mention an existing Peer Band panel', () => {
        const alertPrompt =
            'Create a Grafana-managed alert for the panel titled "Module 2 Pressure — Alert Test Peer Band ±2σ" on the dashboard with UID = afq7tc6hl1m9sb. Configure the alert to trigger when the Module 1 Actual value is greater than the Upper Bound (±2σ) or less than the Lower Bound (±2σ). Modify the panel queries as needed so they are compatible with Grafana Alerting. Use Reduce expressions with the Last function for the Actual, Upper Bound, and Lower Bound queries, then create a Math expression that evaluates: Actual > Upper Bound OR Actual < Lower Bound. Configure the alert to notify the Alex Test Email contact point.';
        expect(messageMentionsPeerBandPanelCreate(alertPrompt)).toBe(false);
        expect(parseAddPeerBandPanelRequest(alertPrompt)).toBeNull();
        expect(messageDescribesPanelCreate(alertPrompt)).toBe(false);
        expect(messageHasProgrammaticHandler(alertPrompt)).toBe(true);
    });

    it('does not steal Add-description-to-alarm-titled prompts that mention Peer Band in the rule name', () => {
        const alarmPrompt =
            'Add a description to the alarm titled "Module 2 Pressure — Alert Test Peer Band ±2σ — outside ±2σ" on the dashboard with UID = afq7tc6hl1m9sb that says ". Description for Pressure Panel"';
        expect(messageMentionsPeerBandPanelCreate(alarmPrompt)).toBe(false);
        expect(parseAddPeerBandPanelRequest(alarmPrompt)).toBeNull();
        expect(messageHasProgrammaticHandler(alarmPrompt)).toBe(true);
    });

    it('parses Modules 1 and 3 through 8 peer lists', () => {
        expect(extractPeerModulesFromMessage('average of Modules 1 and 3 through 8', 2)).toEqual([
            1, 3, 4, 5, 6, 7, 8,
        ]);
    });
});

describe('buildPeerBandPanel', () => {
    it('builds four Flux targets with peer union and ±2σ math', () => {
        const panel = buildPeerBandPanel({
            machineId: '2406-176021',
            moduleNumber: 2,
            influxDatasourceUid: 'influx-uid',
            panelTitle: 'Module 2 Current — Alert Test Peer Band ±2σ',
            peerModules: [1, 3, 4, 5, 6, 7, 8],
            labels: {
                actual: 'Module 2 Actual',
                peerMean: 'Peer Mean',
                upper: 'Upper Peer Bound (±2σ)',
                lower: 'Lower Peer Bound (±2σ)',
            },
        });
        const targets = panel.targets as Array<{ refId: string; query: string; legendFormat: string }>;
        expect(targets).toHaveLength(4);
        expect(targets[0].query).toContain('Module2_Current_A');
        expect(targets[0].query).toContain('2406-176021');
        expect(peerBandQueryUsesUnionTemplate(targets[1].query)).toBe(true);
        expect(targets[1].query).toContain('Module1_Current_A');
        expect(targets[1].query).toContain('Module5_Current_A');
        expect(targets[1].query).not.toContain('Module2_Current_A');
        expect(targets[2].query).toMatch(/math\.sqrt|2\.0 \* std/);
        expect(targets[3].query).toMatch(/math\.sqrt|2\.0 \* std/);
        expect(targets.map((t) => t.legendFormat)).toEqual([
            'Module 2 Actual',
            'Peer Mean',
            'Upper Peer Bound (±2σ)',
            'Lower Peer Bound (±2σ)',
        ]);
    });

    it('uses PressureN_psi fields for Pressure peer-band panels', () => {
        const fields = resolvePeerBandMetricFields(2, [1, 3, 4, 5, 6, 7, 8], 'pressure');
        const panel = buildPeerBandPanel({
            machineId: '2505-200033',
            moduleNumber: 2,
            influxDatasourceUid: 'influx-uid',
            panelTitle: 'Module 2 Pressure — Alert Test Peer Band ±2σ',
            peerModules: [1, 3, 4, 5, 6, 7, 8],
            actualField: fields.actualField,
            peerFields: fields.peerFields,
            unit: fields.unit,
        });
        const targets = panel.targets as Array<{ query: string }>;
        expect(targets[0].query).toContain('Pressure2_psi');
        expect(targets[0].query).not.toContain('Module2_Current_A');
        expect(targets[1].query).toContain('Pressure1_psi');
        expect(targets[1].query).toContain('Pressure8_psi');
        expect(targets[1].query).not.toContain('Pressure2_psi');
        expect((panel.fieldConfig as { defaults?: { unit?: string } }).defaults?.unit).toBe('psi');
    });
});
