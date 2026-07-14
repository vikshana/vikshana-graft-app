import {
    DASHBOARD_REVIEW_EXAMPLE_PROMPT,
    parseDashboardImproveRequest,
    parseDashboardReviewRequest,
    userWantsDashboardImproveApply,
    userWantsDashboardReviewApply,
    userWantsDashboardReviewOnly,
} from './dashboardReviewParse';

describe('dashboardReviewParse', () => {
    it('matches the Keysight readability review prompt', () => {
        expect(userWantsDashboardReviewOnly(DASHBOARD_REVIEW_EXAMPLE_PROMPT)).toBe(true);
        const req = parseDashboardReviewRequest(DASHBOARD_REVIEW_EXAMPLE_PROMPT);
        expect(req).toEqual({
            dashboardUid: 'cfo0wckufbdhce',
            suggestionCount: 3,
        });
    });

    it('does not match apply/implement follow-ups as review-only', () => {
        expect(userWantsDashboardReviewApply('Apply the three improvements to dashboard cfo0wckufbdhce')).toBe(true);
        expect(
            userWantsDashboardReviewOnly('Apply the three improvements to dashboard uid cfo0wckufbdhce')
        ).toBe(false);
    });

    it('does not match alert create prompts that only say Evaluate every minute', () => {
        const alertRule =
            'Create a Grafana-managed alert rule for the panel titled "Module 2 Current — Alert Test Own History ±2σ" on the dashboard with UID = afq7tc6hl1m9sb. Evaluate every minute. Require the condition to be true for one minute. Send notifications to Alex Test Email.';
        expect(userWantsDashboardReviewOnly(alertRule)).toBe(false);
        expect(parseDashboardReviewRequest(alertRule)).toBeNull();
    });
});

// Regression: "Suggest improvements AND apply" went to the LLM (because "apply" turned off
// review-only), which truncated the 34-panel JSON and looped without ever saving. This must
// now route to the programmatic improve+apply fast path instead.
describe('dashboard improve + apply intent', () => {
    const PROMPT = 'Suggest improvements and apply the changes to the dashboard with UID = ffq3wabj0i70gd';

    it('classifies the user prompt as an improve+apply request', () => {
        expect(userWantsDashboardImproveApply(PROMPT)).toBe(true);
        expect(parseDashboardImproveRequest(PROMPT)).toEqual({ dashboardUid: 'ffq3wabj0i70gd' });
    });

    it('does not treat improve+apply as a review-only request', () => {
        expect(userWantsDashboardReviewOnly(PROMPT)).toBe(false);
        expect(parseDashboardReviewRequest(PROMPT)).toBeNull();
    });

    it('also matches "review ... and update the dashboard"', () => {
        const p = 'Review dashboard UID = abc123 and update the dashboard with the improvements';
        expect(userWantsDashboardImproveApply(p)).toBe(true);
        expect(parseDashboardImproveRequest(p)?.dashboardUid).toBe('abc123');
    });

    it('ignores an apply request with no review/improve verb (e.g. a rename apply)', () => {
        expect(userWantsDashboardImproveApply('Apply the rename to dashboard UID = abc123')).toBe(false);
        expect(parseDashboardImproveRequest('Apply the rename to dashboard UID = abc123')).toBeNull();
    });

    it('requires a dashboard uid', () => {
        expect(parseDashboardImproveRequest('Suggest improvements and apply them')).toBeNull();
    });

    it('does not fire for suggestions-only requests', () => {
        expect(userWantsDashboardImproveApply(DASHBOARD_REVIEW_EXAMPLE_PROMPT)).toBe(false);
    });
});
