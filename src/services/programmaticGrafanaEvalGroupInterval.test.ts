import { of, throwError } from 'rxjs';
import { parseGrafanaEvalGroupIntervalRequest } from './grafanaAlertParse';
import { runProgrammaticGrafanaEvalGroupInterval } from './programmaticGrafanaEvalGroupInterval';

const mockFetch = jest.fn();

jest.mock('@grafana/runtime', () => ({
    getBackendSrv: () => ({
        fetch: (...args: unknown[]) => mockFetch(...args),
    }),
}));

describe('runProgrammaticGrafanaEvalGroupInterval', () => {
    beforeEach(() => {
        mockFetch.mockReset();
    });

    const prompt = "Change the Evaluation Interval of 'Test Eval Group' to be 2 minutes.";

    it('PUTs the rule-group interval and verifies it', async () => {
        let groupPut: { interval?: number; title?: string } | undefined;
        let verified = false;

        mockFetch.mockImplementation((req: { url: string; method?: string; data?: unknown }) => {
            if (
                req.url.includes('/alert-rules') &&
                (req.method ?? 'GET') === 'GET' &&
                !/\/alert-rules\/[\w-]+$/.test(req.url)
            ) {
                return of({
                    data: [
                        {
                            uid: 'rule-1',
                            title: 'GraftAI Rule',
                            folderUID: 'folder-graftai',
                            ruleGroup: 'Test Eval Group',
                            for: '1m',
                        },
                    ],
                });
            }
            if (req.url.includes('/rule-groups/') && (req.method ?? 'GET') === 'GET') {
                return of({
                    data: {
                        title: 'Test Eval Group',
                        folderUid: 'folder-graftai',
                        interval: verified || groupPut ? 120 : 60,
                        rules: [],
                    },
                });
            }
            if (req.url.includes('/rule-groups/') && req.method === 'PUT') {
                groupPut = req.data as { interval?: number; title?: string };
                return of({ data: groupPut });
            }
            if (/\/alert-rules\/rule-1$/.test(req.url) && (req.method ?? 'GET') === 'GET') {
                return of({
                    data: {
                        uid: 'rule-1',
                        title: 'GraftAI Rule',
                        folderUID: 'folder-graftai',
                        ruleGroup: 'Test Eval Group',
                        for: '1m',
                    },
                });
            }
            if (/\/alert-rules\/rule-1$/.test(req.url) && req.method === 'PUT') {
                verified = true;
                return of({ data: { uid: 'rule-1', for: '2m' } });
            }
            return throwError(() => new Error(`unexpected url ${req.url} method ${req.method}`));
        });

        const req = parseGrafanaEvalGroupIntervalRequest(prompt)!;
        expect(req).toEqual({ ruleGroup: 'Test Eval Group', every: '2m' });

        const result = await runProgrammaticGrafanaEvalGroupInterval(req, 201);
        expect(result.ok).toBe(true);
        expect(result.ruleGroup).toBe('Test Eval Group');
        expect(result.evalIntervalSeconds).toBe(120);
        expect(result.previousIntervalSeconds).toBe(60);
        expect(groupPut?.interval).toBe(120);
        expect(result.rulesPendingAdjusted).toBe(1);
    });

    it('returns a clear error when the group is missing', async () => {
        mockFetch.mockImplementation((req: { url: string; method?: string }) => {
            if (req.url.includes('/alert-rules') && (req.method ?? 'GET') === 'GET') {
                return of({
                    data: [
                        {
                            uid: 'other',
                            title: 'Other',
                            folderUID: 'folder-a',
                            ruleGroup: 'Other Group',
                        },
                    ],
                });
            }
            return throwError(() => new Error(`unexpected url ${req.url}`));
        });

        const req = parseGrafanaEvalGroupIntervalRequest(prompt)!;
        const result = await runProgrammaticGrafanaEvalGroupInterval(req, 201);
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/Test Eval Group.*not found/i);
    });
});
