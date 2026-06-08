import {
    clearGraftFailures,
    exportGraftOperatorReportAsJson,
    exportGraftOperatorReportAsMarkdown,
    recordGraftFailure,
} from './graftOperatorFailureLog';

describe('graftOperatorFailureLog export', () => {
    beforeEach(() => {
        clearGraftFailures();
    });

    it('includes registry suggestions in markdown report', () => {
        recordGraftFailure({
            buildNumber: 145,
            intent: 'full-llm',
            userMessagePreview:
                'Rebuild the dashboard of UID = cfo0wckufbdhce from scratch using best practices.',
            error: 'Would you like to keep these panels?',
        });

        const md = exportGraftOperatorReportAsMarkdown();
        expect(md).toContain('Suggested programmatic registry rows');
        expect(md).toContain('dashboard_rebuild');
        expect(md).toContain('PROGRAMMATIC_FALLBACK_REGISTRY');
    });

    it('exports json with failures and suggestions', () => {
        recordGraftFailure({
            buildNumber: 145,
            intent: 'dashboard-rebuild',
            userMessagePreview: 'test',
            error: 'update_dashboard failed',
        });

        const parsed = JSON.parse(exportGraftOperatorReportAsJson()) as {
            failureCount: number;
            suggestedRegistryRows: { kind: string }[];
        };
        expect(parsed.failureCount).toBe(1);
        expect(parsed.suggestedRegistryRows.length).toBeGreaterThan(0);
    });
});
