import { readFileSync } from 'fs';
import {
    extractPanelJsonFromMessage,
    messageMentionsPanelJsonDuplicateIntent,
    parsePanelJsonDuplicateRequest,
} from './panelJsonDuplicateParse';
import { messageMentionsSinglePanelCopyIntent } from './singlePanelCopyParse';

describe('panelJsonDuplicateParse', () => {
    const fixture = readFileSync(
        require('path').join(__dirname, '../../scripts/fixtures/panel-module5-randomforest-ml-influx.json'),
        'utf8'
    );

    const userPrompt =
        'in dashboard named "2406-176021 / Exsolve". can you make a duplicate of the panel named "Module 5 Current — History Comparison" ' +
        'and then replace the json of that new panel with this json ' +
        fixture;

    it('parses embedded panel JSON and does not treat dates as machine ids', () => {
        expect(messageMentionsPanelJsonDuplicateIntent(userPrompt)).toBe(true);
        expect(messageMentionsSinglePanelCopyIntent(userPrompt)).toBe(false);
        const req = parsePanelJsonDuplicateRequest(userPrompt);
        expect(req?.dashboardTitle).toBe('2406-176021 / Exsolve');
        expect(req?.machineId).toBe('2406-176021');
        expect(req?.sourcePanelTitle).toBe('Module 5 Current — History Comparison');
        // Legacy "RandomForest ML (Influx)" is normalized to the operator-facing label.
        expect(req?.panelJson.title).toBe('Module 5 Current — History Comparison (historical / Influx)');
        expect((req?.panelJson.targets as unknown[]).length).toBe(4);
    });

    it('extracts panel object from message', () => {
        const panel = extractPanelJsonFromMessage(userPrompt);
        expect(panel?.type).toBe('timeseries');
    });
});
