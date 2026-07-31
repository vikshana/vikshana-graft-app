import { parseAddPeerRfPanelRequest, messageMentionsAddPeerRfPanel } from './peerRfPanelAddParse';
import {
    parseAddHistoryComparisonPanelRequest,
    messageMentionsPredictiveAnalyticsPanel,
} from './historyComparisonPanelAddParse';
import { messageHasProgrammaticHandler } from './programmaticChatIntents';
import { messageMentionsPeerBandPanelCreate } from './peerBandPanelAddParse';

/** Exact operator wording from production "peer-RF not available" failure (build 210). */
export const OPERATOR_MODULE2_PEER_RF_PROMPT =
    'Create a machine learning panel titled "Module 2 Current — RandomForest vs Peers" on the dashboard with UID afq7tc6hl1m9sb. Compare Module 2 Current against the peer modules using a RandomForest anomaly detection model. Plot the Module 2 Actual values and the RandomForest anomaly score or prediction. If a RandomForest model is not available, explain what additional configuration or data is required instead of creating placeholder queries';

const FIXTURE_MODULE3 =
    'Create a RandomForest vs Peers (Influx) machine learning panel for Module 3 Current for the dashboard with UID = afq7tc6hl1m9sb.';

const SENSING_VOLTAGE =
    'Create a Random Forest machine learning panel for sensing voltage on the dashboard with UID = afq7tc6hl1m9sb.';

describe('operator RandomForest prompts', () => {
    it('routes the production Module 2 peer-RF prompt to peer-rf, not history comparison', () => {
        expect(messageMentionsAddPeerRfPanel(OPERATOR_MODULE2_PEER_RF_PROMPT)).toBe(true);
        expect(parseAddPeerRfPanelRequest(OPERATOR_MODULE2_PEER_RF_PROMPT)).toEqual(
            expect.objectContaining({
                dashboardUid: 'afq7tc6hl1m9sb',
                moduleNumber: 2,
            })
        );
        expect(parseAddHistoryComparisonPanelRequest(OPERATOR_MODULE2_PEER_RF_PROMPT)).toBeNull();
        expect(messageMentionsPredictiveAnalyticsPanel(OPERATOR_MODULE2_PEER_RF_PROMPT)).toBe(false);
        expect(messageMentionsPeerBandPanelCreate(OPERATOR_MODULE2_PEER_RF_PROMPT)).toBe(false);
        expect(messageHasProgrammaticHandler(OPERATOR_MODULE2_PEER_RF_PROMPT)).toBe(true);
    });

    it('keeps fixture Module 3 peer-rf and sensing-voltage history comparison distinct', () => {
        expect(parseAddPeerRfPanelRequest(FIXTURE_MODULE3)?.moduleNumber).toBe(3);
        expect(parseAddPeerRfPanelRequest(SENSING_VOLTAGE)).toBeNull();
        expect(messageMentionsPredictiveAnalyticsPanel(SENSING_VOLTAGE)).toBe(true);
        expect(parseAddHistoryComparisonPanelRequest(SENSING_VOLTAGE)?.signal?.field).toBe(
            'Cartridge_Sensing_Voltage'
        );
    });
});
