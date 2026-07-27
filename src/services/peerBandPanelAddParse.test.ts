import {
    extractPeerModulesFromMessage,
    messageMentionsPeerBandPanelCreate,
    parseAddPeerBandPanelRequest,
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

    it('parses the Alert Test Peer Band create prompt', () => {
        expect(messageMentionsPeerBandPanelCreate(PROMPT)).toBe(true);
        const req = parseAddPeerBandPanelRequest(PROMPT);
        expect(req).not.toBeNull();
        expect(req?.dashboardUid).toBe('idHkqdqnk');
        expect(req?.moduleNumber).toBe(2);
        expect(req?.panelTitle).toBe('Module 2 Current — Alert Test Peer Band ±2σ');
        expect(req?.peerModules).toEqual([1, 3, 4, 5, 6, 7, 8]);
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
});
