/**
 * Generated paraphrases of the lab-PDF jobs. Graft must decide (handler) or ask
 * one question — never fall through to LLM-only for these operator intents.
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
import { messageHasProgrammaticHandler } from '../programmaticChatIntents';
import { formatClarificationIfNeeded, formatOperatorClarificationIfNeeded } from '../requestClarity';
import {
    PARAPHRASE_COUNT,
    PARAPHRASE_SEED,
    makeParaphraseRng,
    randomClonePrompts,
    randomDashboardRenamePrompts,
    randomOwnHistoryPrompts,
    randomPanelRenamePrompts,
    randomPeerRfPrompts,
    randomTemperaturePrompts,
    randomUnmatchedPrompts,
    randomWriteupPrompts,
} from './operatorParaphraseGenerator';

const rng = makeParaphraseRng();

function mustHandleOrAsk(prompt: string): void {
    const handled = messageHasProgrammaticHandler(prompt);
    const asked = Boolean(formatClarificationIfNeeded(prompt));
    expect(handled || asked).toBe(true);
}

describe('clone paraphrases (Skywater-FL → 2505-200033)', () => {
    it.each([
        'I have a machine from Keysight for 2505-200033. Create a dashboard for it that is a copy of Skywater-FL, but with data for 2505-200033.',
        'Copy Skywater-FL for 2505-200033.',
        'Duplicate Skywater-FL for 2505-200033.',
        'Clone Skywater-FL for machine 2505-200033.',
        'Make a dashboard like Skywater FL with data for 2505-200033.',
        'Create a dashboard based on Skywater-FL with data for 2505-200033.',
        'Visual copy of Skywater-FL with data for 2505-200033.',
        'Please replicate Skywater-FL for 2505-200033.',
        'Can you copy Skywater-FL over to 2505-200033?',
        'I need a copy of Skywater-FL for our 2505-200033 unit.',
        'Use Skywater-FL as the template for 2505-200033.',
        'Stand up a dashboard for 2505-200033 using Skywater-FL as the template.',
        'Build 2505-200033 from Skywater-FL.',
        'Same dashboard as Skywater-FL but pointed at 2505-200033.',
    ])('%s', (prompt) => {
        mustHandleOrAsk(prompt);
        expect(userWantsDashboardClone(prompt)).toBe(true);
        const parsed = parseCloneIntentMessage(prompt);
        if (!parsed.valid) {
            expect(formatClarificationIfNeeded(prompt)).toMatch(/Need clarification/i);
            return;
        }
        expect(parsed.sourceDashboardTitle).toMatch(/Skywater/i);
        expect(parsed.targetMachineId).toBe('2505-200033');
    });
});

describe('dashboard rename paraphrases (6sFerv44k → NewSkywater-FL)', () => {
    it.each([
        'Rename the dashboard for the 6sFerv44k machine to be NewSkywater-FL instead of the current name.',
        'Rename dashboard uid=6sFerv44k to NewSkywater-FL.',
        'Rename the dashboard with UID = 6sFerv44k to be NewSkywater-FL.',
        'Please rename 6sFerv44k dashboard to NewSkywater-FL.',
        'For uid 6sFerv44k, rename the dashboard to NewSkywater-FL.',
    ])('%s', (prompt) => {
        mustHandleOrAsk(prompt);
        expect(userWantsDashboardRename(prompt)).toBe(true);
        const req = parseDashboardRenameRequest(prompt);
        expect(req?.dashboardUid).toBe('6sFerv44k');
        expect(req?.newLabel).toBe('NewSkywater-FL');
    });
});

describe('panel rename paraphrases (Current → NewCurrent on idHkqdqnk)', () => {
    it.each([
        'Rename the "Current" panel on the dashboard with UID = idHkqdqnk to be "NewCurrent.',
        'Rename the "Current" panel on the dashboard with UID = idHkqdqnk to be "NewCurrent".',
        'Rename panel "Current" to "NewCurrent" on dashboard uid=idHkqdqnk.',
        'Please rename the Current panel to NewCurrent (dashboard uid idHkqdqnk).',
    ])('%s', (prompt) => {
        mustHandleOrAsk(prompt);
        expect(userWantsPanelRename(prompt)).toBe(true);
        const req = parsePanelRenameRequest(prompt);
        expect(req?.dashboardUid).toBe('idHkqdqnk');
        expect(req?.currentPanelTitle?.toLowerCase()).toContain('current');
        expect(req?.newPanelTitle?.toLowerCase()).toContain('newcurrent');
    });
});

describe('own-history paraphrases (Sensing Voltage, idHkqdqnk)', () => {
    it.each([
        'Create a machine learning panel that compares Sensing Voltage against its own history for the dashboard with UID = idHkqdqnk.',
        'Add an own history ±2σ panel for Sensing Voltage on uid=idHkqdqnk.',
        'Make a vs own history panel for Sensing Voltage on dashboard idHkqdqnk.',
        'Create a historical mean ± 2 standard deviation panel for Sensing Voltage on idHkqdqnk.',
        'Create a machine learning panel that compares Sensing Voltage against its own history for the dashboard with UID = idHkqdqnk.',
        'Please add an own-history ±2σ band for Average Sensing Voltage on uid=idHkqdqnk.',
        'Add a vs own history panel for plant temperature on the dashboard with UID = idHkqdqnk.',
    ])('%s', (prompt) => {
        mustHandleOrAsk(prompt);
        expect(messageMentionsOwnHistoryPanel(prompt)).toBe(true);
        expect(messageMentionsPredictiveAnalyticsPanel(prompt)).toBe(false);
        expect(messageMentionsAddPeerRfPanel(prompt)).toBe(false);
        const req = parseAddOwnHistoryPanelRequest(prompt);
        expect(req?.dashboardUid).toBe('idHkqdqnk');
        expect(req?.metricLabel?.toLowerCase()).toMatch(/sensing voltage|temperature/);
    });
});

describe('peer-RF paraphrases (Module 3 Current, idHkqdqnk)', () => {
    it.each([
        'Create a RandomForest vs Peers (Influx) machine learning panel for Module 3 Current for the dashboard with UID = idHkqdqnk.',
        'Add RandomForest vs Peers for Module 3 Current on uid=idHkqdqnk.',
        'Create a peer RF Influx panel for Module 3 Current on dashboard idHkqdqnk.',
        'Add RandomForest vs Peers for Module 3 Current vs its peer modules on UID = idHkqdqnk.',
        'Please add RF vs Peers (Influx) for module 3 current, dashboard idHkqdqnk.',
        'I need a Random Forest vs peers panel for Module 3 Current on idHkqdqnk.',
    ])('%s', (prompt) => {
        mustHandleOrAsk(prompt);
        expect(messageMentionsAddPeerRfPanel(prompt)).toBe(true);
        expect(messageMentionsPredictiveAnalyticsPanel(prompt)).toBe(false);
        const req = parseAddPeerRfPanelRequest(prompt);
        expect(req?.moduleNumber).toBe(3);
        expect(req?.dashboardUid).toBe('idHkqdqnk');
    });
});

describe('Temperature paraphrases (plant metric, not Module Current)', () => {
    it.each([
        'Create a RandomForest vs Peers machine learning panel for the Temperature parameter on the dashboard with UID = idHkqdqnk.',
        'Add a history comparison for Temperature on uid=idHkqdqnk.',
        'Create a predictive analytics panel for Temperature on dashboard idHkqdqnk.',
        'Create a Temperature Random Forest panel on dashboard UID = idHkqdqnk.',
        'Create a plant temperature ML panel on dashboard UID = idHkqdqnk.',
    ])('%s', (prompt) => {
        mustHandleOrAsk(prompt);
        expect(messageMentionsAddPeerRfPanel(prompt)).toBe(false);
        const hc = parseAddHistoryComparisonPanelRequest(prompt);
        expect(hc?.signal?.field).toBe('Temperature_C');
        expect(hc?.signal?.field).not.toBe('Module3_Current_A');
    });
});

describe('history-comparison paraphrases (Module 1 anomaly, idHkqdqnk)', () => {
    it.each([
        'Create a machine learning/anomaly detection panel for Module 1 on the dashboard with the UID = idHkqdqnk.',
        'Set up an anomaly detection panel for Module 1 on the dashboard with UID = idHkqdqnk.',
        'Add a predictive analytics panel for Module 1 Current on uid=idHkqdqnk.',
        'Please create an ML/anomaly detection panel for Module 1 on dashboard idHkqdqnk.',
    ])('%s', (prompt) => {
        mustHandleOrAsk(prompt);
        expect(messageMentionsPredictiveAnalyticsPanel(prompt)).toBe(true);
        expect(messageMentionsOwnHistoryPanel(prompt)).toBe(false);
        const req = parseAddHistoryComparisonPanelRequest(prompt);
        expect(req?.dashboardUid).toBe('idHkqdqnk');
        expect(req?.moduleNumber).toBe(1);
        expect(req?.signal?.field).toBe('Module1_Current_A');
    });
});

describe(`random paraphrases each run (seed ${PARAPHRASE_SEED}, n=${PARAPHRASE_COUNT})`, () => {
    it.each(randomClonePrompts(rng))('clone: %s', (prompt) => {
        mustHandleOrAsk(prompt);
        expect(userWantsDashboardClone(prompt)).toBe(true);
        const parsed = parseCloneIntentMessage(prompt);
        if (!parsed.valid) {
            expect(formatClarificationIfNeeded(prompt)).toMatch(/Need clarification/i);
            return;
        }
        expect(parsed.sourceDashboardTitle).toMatch(/Skywater/i);
        expect(parsed.targetMachineId).toBe('2505-200033');
    });

    it.each(randomDashboardRenamePrompts(rng))('dashboard rename: %s', (prompt) => {
        mustHandleOrAsk(prompt);
        expect(userWantsDashboardRename(prompt)).toBe(true);
        const req = parseDashboardRenameRequest(prompt);
        expect(req?.dashboardUid).toBe('6sFerv44k');
        expect(req?.newLabel).toBe('NewSkywater-FL');
    });

    it.each(randomPanelRenamePrompts(rng))('panel rename: %s', (prompt) => {
        mustHandleOrAsk(prompt);
        expect(userWantsPanelRename(prompt)).toBe(true);
        const req = parsePanelRenameRequest(prompt);
        expect(req?.dashboardUid).toBe('idHkqdqnk');
        expect(req?.currentPanelTitle?.toLowerCase()).toContain('current');
        expect(req?.newPanelTitle?.toLowerCase()).toContain('newcurrent');
    });

    it.each(randomOwnHistoryPrompts(rng))('own-history: %s', (prompt) => {
        mustHandleOrAsk(prompt);
        expect(messageMentionsOwnHistoryPanel(prompt)).toBe(true);
        expect(messageMentionsPredictiveAnalyticsPanel(prompt)).toBe(false);
        const req = parseAddOwnHistoryPanelRequest(prompt);
        expect(req?.dashboardUid).toBe('idHkqdqnk');
        expect(req?.metricLabel?.toLowerCase()).toMatch(/sensing voltage|temperature/);
    });

    it.each(randomPeerRfPrompts(rng))('peer-RF: %s', (prompt) => {
        mustHandleOrAsk(prompt);
        expect(messageMentionsAddPeerRfPanel(prompt)).toBe(true);
        expect(messageMentionsPredictiveAnalyticsPanel(prompt)).toBe(false);
        const req = parseAddPeerRfPanelRequest(prompt);
        expect(req?.moduleNumber).toBe(3);
        expect(req?.dashboardUid).toBe('idHkqdqnk');
    });

    it.each(randomTemperaturePrompts(rng))('temperature: %s', (prompt) => {
        mustHandleOrAsk(prompt);
        expect(messageMentionsAddPeerRfPanel(prompt)).toBe(false);
        const hc = parseAddHistoryComparisonPanelRequest(prompt);
        expect(hc?.signal?.field).toBe('Temperature_C');
    });

    it.each(randomUnmatchedPrompts(rng))('unmatched asks: %s', (prompt) => {
        const clarification = formatOperatorClarificationIfNeeded(prompt);
        expect(clarification).toMatch(/Need clarification/i);
        expect(clarification).not.toMatch(/### Done/);
    });

    it.each(randomWriteupPrompts(rng))('write-up paraphrase: %s', (prompt) => {
        mustHandleOrAsk(prompt);
    });
});

describe('unmatched English must ask, not silently LLM', () => {
    it.each([
        'Add the usual ML stuff to the Keysight dashboard.',
        'Make the Skywater dashboard prettier.',
        'Do the normal machine learning thing on uid=idHkqdqnk.',
        'Can you set up analytics like last time?',
    ])('%s', (prompt) => {
        const clarification = formatOperatorClarificationIfNeeded(prompt);
        expect(clarification).toMatch(/Need clarification/i);
        expect(clarification).not.toMatch(/### Done/);
    });
});
