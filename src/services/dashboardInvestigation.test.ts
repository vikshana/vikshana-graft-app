import { isDashboardDataInvestigationQuestion } from './dashboardInvestigation';
import { userWantsDashboardPanelFix } from './dashboardCloneProgress';
import { appendDashboardReferencesToReply } from './appendToolReferences';

const backfillQuestion =
    'Below is the script to backfill 30 days of data. With the dashboard with UID "6gawrgawrgragg", ' +
    'I would like to inspect the time period from ~15:00 ET on Monday 5/11 until ~15:00 ET on Tuesday 5/12 ' +
    'on the panel Module 5 Current — vs. Peer Band. when I select this period and look at the chart it show no data? why?';

const fixUser =
    'Fix panels on 2505-200033 / Keysight that show errors or still use 2103-176030 instead of 2505-200033.';

describe('isDashboardDataInvestigationQuestion', () => {
    it('detects why / no data / backfill questions', () => {
        expect(isDashboardDataInvestigationQuestion(backfillQuestion)).toBe(true);
        expect(isDashboardDataInvestigationQuestion('Why does this panel show no data for last week?')).toBe(
            true
        );
    });

    it('does not treat explicit fix requests as investigation', () => {
        expect(isDashboardDataInvestigationQuestion(fixUser)).toBe(false);
    });
});

describe('userWantsDashboardPanelFix vs investigation', () => {
    it('does not classify backfill why-no-data as panel fix', () => {
        expect(userWantsDashboardPanelFix(backfillQuestion)).toBe(false);
    });

    it('still classifies explicit fix panels requests', () => {
        expect(userWantsDashboardPanelFix(fixUser)).toBe(true);
    });
});

describe('appendDashboardReferencesToReply investigation', () => {
    it('does not replace investigation answers with panel fix template', () => {
        const modelAnswer =
            'The panel queries Prometheus for machine_metric_expected; backfill writes one point per chunk end.';
        const out = appendDashboardReferencesToReply(
            modelAnswer,
            [{ name: 'get_dashboard_summary', status: 'success', userReference: '**Panel index**' }],
            [backfillQuestion],
            backfillQuestion
        );
        expect(out).toContain('Prometheus');
        expect(out).not.toContain('### Not finished yet');
        expect(out).not.toContain('### Done (panel fix)');
        expect(out).not.toContain('Panel index');
    });
});
