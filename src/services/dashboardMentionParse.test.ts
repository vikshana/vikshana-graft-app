import {
    extractAllDashboardUids,
    extractClaimedVendorDashboardUid,
    extractDashboardUidFromMessage,
    extractPanelIdFromMessage,
    looksLikeGrafanaDashboardUid,
} from './dashboardMentionParse';
import { userWantsDashboardPanelFix } from './dashboardCloneProgress';
import { formatClarificationIfNeeded } from './requestClarity';

const userMsg =
    'on dash board which has the UID "6gawrgawrgragg"  in panel 35 which is named "Module 5 Current — vs. Peer Band (Modules 1–4,6–8 Avg ± 2σ). ", ' +
    'i still get these errors: B Status: 500. Message: invalid: error @7:16-7:25: found unexpected argument by';

describe('dashboardMentionParse', () => {
    it('parses uid from "which has the UID"', () => {
        expect(extractDashboardUidFromMessage(userMsg)).toBe('6gawrgawrgragg');
    });

    it('parses panel 35 from "in panel 35"', () => {
        expect(extractPanelIdFromMessage(userMsg)).toBe(35);
    });

    it('does not treat vendor names like Keysight as Grafana uids', () => {
        expect(looksLikeGrafanaDashboardUid('Keysight')).toBe(false);
        expect(looksLikeGrafanaDashboardUid('Skywater')).toBe(false);
        expect(looksLikeGrafanaDashboardUid('6sFerv44k')).toBe(true);
        expect(looksLikeGrafanaDashboardUid('idHkqdqnk')).toBe(true);
        expect(
            extractAllDashboardUids(
                'Create useful graphs for the Keysight machine on the dashboard with UID = cfo0wckufbdhce.'
            )
        ).toEqual(['cfo0wckufbdhce']);
        expect(
            extractAllDashboardUids('Rename the dashboard for the Keysight machine to be NewMachine.')
        ).not.toContain('Keysight');
        expect(extractAllDashboardUids('Rename dashboard uid=Keysight to NewSkywater-FL')).not.toContain(
            'Keysight'
        );
        expect(extractClaimedVendorDashboardUid('Rename dashboard uid=Keysight to NewSkywater-FL')).toBe(
            'Keysight'
        );
        expect(extractClaimedVendorDashboardUid('on uid=idHkqdqnk')).toBeUndefined();
    });

    it('extracts uid from rename UID dashboard and rename the UID dashboard', () => {
        expect(extractAllDashboardUids('Please rename 6sFerv44k dashboard to NewSkywater-FL')).toContain(
            '6sFerv44k'
        );
        expect(
            extractAllDashboardUids('Rename the 6sFerv44k dashboard to NewSkywater-FL')
        ).toContain('6sFerv44k');
    });
});

describe('panel fix + clarification', () => {
    it('recognizes as panel fix request', () => {
        expect(userWantsDashboardPanelFix(userMsg)).toBe(true);
    });

    it('does not ask for clarification', () => {
        expect(formatClarificationIfNeeded(userMsg)).toBeNull();
    });
});
