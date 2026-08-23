/**
 * Operator English from the Skywater-FL lab PDF — phrasing that used to work
 * or should decide/clarify instead of hard-failing on exact template wording.
 */
import { parseCloneIntentMessage } from '../dashboardCloneParse';
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
import { messageMentionsGrafanaAlertCreate } from '../grafanaAlertParse';
import { extractAllDashboardUids } from '../dashboardMentionParse';

const SKYWATER_CLONE =
    'I have a machine from Keysight for 2505-200033. Create a dashboard for it that is a copy of Skywater-FL, but with data for 2505-200033.';

const DASHBOARD_RENAME =
    'Rename the dashboard for the 6sFerv44k machine to be NewSkywater-FL instead of the current name.';

const PANEL_RENAME =
    'Rename the "Current" panel on the dashboard with UID = idHkqdqnk to be "NewCurrent.';

const OWN_HISTORY =
    'Create a machine learning panel that compares Sensing Voltage against its own history for the dashboard with UID = idHkqdqnk.';

const PEER_RF =
    'Create a RandomForest vs Peers (Influx) machine learning panel for Module 3 Current for the dashboard with UID = idHkqdqnk.';

const TEMPERATURE =
    'Create a RandomForest vs Peers machine learning panel for the Temperature parameter on the dashboard with UID = idHkqdqnk.';

describe('operator phrasing (lab PDF)', () => {
    it('clone: copy of dashboard title + target machine id is valid English', () => {
        const p = parseCloneIntentMessage(SKYWATER_CLONE);
        expect(p.valid).toBe(true);
        expect(p.sourceDashboardTitle).toMatch(/Skywater-FL/i);
        expect(p.targetMachineId).toBe('2505-200033');
        expect(p.sourceMachineId).not.toBe('2505-200033');
        expect(p.error).toBeUndefined();
    });

    it('dashboard rename: Grafana uid used as "machine" plus unquoted new name', () => {
        expect(userWantsDashboardRename(DASHBOARD_RENAME)).toBe(true);
        const req = parseDashboardRenameRequest(DASHBOARD_RENAME);
        expect(req?.dashboardUid).toBe('6sFerv44k');
        expect(req?.newLabel).toBe('NewSkywater-FL');
        expect(req?.replaceLabel).not.toBe('the');
    });

    it('panel rename: unclosed quote on the new title still parses', () => {
        expect(userWantsPanelRename(PANEL_RENAME)).toBe(true);
        const req = parsePanelRenameRequest(PANEL_RENAME);
        expect(req?.currentPanelTitle).toBe('Current');
        expect(req?.newPanelTitle).toBe('NewCurrent');
        expect(req?.dashboardUid).toBe('idHkqdqnk');
    });

    it('own-history: "compares X against its own history" is own-history, not RF History Comparison', () => {
        expect(messageMentionsOwnHistoryPanel(OWN_HISTORY)).toBe(true);
        expect(messageMentionsPredictiveAnalyticsPanel(OWN_HISTORY)).toBe(false);
        const req = parseAddOwnHistoryPanelRequest(OWN_HISTORY);
        expect(req?.dashboardUid).toBe('idHkqdqnk');
        expect(req?.metricLabel?.toLowerCase()).toContain('sensing voltage');
        expect(messageMentionsGrafanaAlertCreate(OWN_HISTORY)).toBe(false);
    });

    it('peer-RF: RandomForest vs Peers (Influx) does not route to History Comparison', () => {
        expect(messageMentionsAddPeerRfPanel(PEER_RF)).toBe(true);
        expect(messageMentionsPredictiveAnalyticsPanel(PEER_RF)).toBe(false);
        const req = parseAddPeerRfPanelRequest(PEER_RF);
        expect(req?.moduleNumber).toBe(3);
        expect(req?.dashboardUid).toBe('idHkqdqnk');
    });

    it('Temperature without module is not peer-RF (ask or use plant metric, do not demand Module N)', () => {
        expect(messageMentionsAddPeerRfPanel(TEMPERATURE)).toBe(false);
        const hc = parseAddHistoryComparisonPanelRequest(TEMPERATURE);
        expect(hc?.signal?.field).toBe('Temperature_C');
        expect(extractAllDashboardUids(TEMPERATURE)).toContain('idHkqdqnk');
    });
});
