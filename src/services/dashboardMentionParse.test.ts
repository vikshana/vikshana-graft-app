import { extractDashboardUidFromMessage, extractPanelIdFromMessage } from './dashboardMentionParse';
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
});

describe('panel fix + clarification', () => {
    it('recognizes as panel fix request', () => {
        expect(userWantsDashboardPanelFix(userMsg)).toBe(true);
    });

    it('does not ask for clarification', () => {
        expect(formatClarificationIfNeeded(userMsg)).toBeNull();
    });
});
