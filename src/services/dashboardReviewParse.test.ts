import {
    DASHBOARD_REVIEW_EXAMPLE_PROMPT,
    parseDashboardReviewRequest,
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

    it('parses numeric suggestion counts', () => {
        const req = parseDashboardReviewRequest(
            'Review dashboard uid=cfo0wckufbdhce and suggest 5 improvements for readability'
        );
        expect(req?.suggestionCount).toBe(5);
    });
});
