import { of, throwError } from 'rxjs';
import { parseGrafanaAlertUpdateRequest } from './grafanaAlertParse';
import { runProgrammaticGrafanaAlertUpdate } from './programmaticGrafanaAlertUpdate';

const mockFetch = jest.fn();

jest.mock('@grafana/runtime', () => ({
    getBackendSrv: () => ({
        fetch: (...args: unknown[]) => mockFetch(...args),
    }),
}));

describe('runProgrammaticGrafanaAlertUpdate', () => {
    beforeEach(() => {
        mockFetch.mockReset();
    });

    const prompt =
        'Update the alert rule named GraftAI Rule. Add one label: key GraftAI Labels, value Alex. Add summary "Module 1 Current Out of Bounds" and description "Module 1 Actual Value is Outside the Own History". Add custom annotation name "Custom Annotation Name" with content "Custom Annotation Content". Configure the rule to notify the Alex Test Email contact point.';

    it('patches labels, annotations, and contact point on an existing rule by name', async () => {
        let putBody: Record<string, unknown> | undefined;
        mockFetch.mockImplementation((req: { url: string; method?: string; data?: unknown }) => {
            if (req.url.includes('/alert-rules') && (req.method ?? 'GET') === 'GET' && !/\/alert-rules\/[\w-]+$/.test(req.url)) {
                return of({
                    data: [
                        {
                            uid: 'rule-existing',
                            title: 'GraftAI Rule',
                            folderUID: 'folder-graftai',
                            ruleGroup: 'GraftAI Alert Groups',
                            labels: { graft: 'true' },
                            annotations: { summary: 'old' },
                        },
                    ],
                });
            }
            if (/\/alert-rules\/rule-existing$/.test(req.url) && (req.method ?? 'GET') === 'GET') {
                return of({
                    data: {
                        uid: 'rule-existing',
                        title: 'GraftAI Rule',
                        folderUID: 'folder-graftai',
                        ruleGroup: 'GraftAI Alert Groups',
                        labels: { graft: 'true' },
                        annotations: { summary: 'old', __dashboardUid__: 'idHkqdqnk' },
                        condition: 'H',
                        data: [],
                        for: '5m',
                        noDataState: 'NoData',
                        execErrState: 'Alerting',
                        orgId: 1,
                    },
                });
            }
            if (req.url.includes('/contact-points') && (req.method ?? 'GET') === 'GET') {
                return of({ data: [{ name: 'Alex Test Email', type: 'email' }] });
            }
            if (/\/alert-rules\/rule-existing$/.test(req.url) && req.method === 'PUT') {
                putBody = req.data as Record<string, unknown>;
                return of({ data: { uid: 'rule-existing', title: 'GraftAI Rule' } });
            }
            return throwError(() => new Error(`unexpected url ${req.url} method ${req.method}`));
        });

        const req = parseGrafanaAlertUpdateRequest(prompt)!;
        const result = await runProgrammaticGrafanaAlertUpdate(req, 195);
        expect(result.ok).toBe(true);
        expect(result.ruleUid).toBe('rule-existing');
        expect(result.contactPoint).toBe('Alex Test Email');
        expect(putBody?.labels).toEqual({ graft: 'true', 'GraftAI Labels': 'Alex' });
        const annotations = putBody?.annotations as Record<string, string>;
        expect(annotations.summary).toBe('Module 1 Current Out of Bounds');
        expect(annotations.description).toBe('Module 1 Actual Value is Outside the Own History');
        expect(annotations['Custom Annotation Name']).toBe('Custom Annotation Content');
        expect(annotations.__dashboardUid__).toBe('idHkqdqnk');
        expect(putBody?.notification_settings).toEqual({ receiver: 'Alex Test Email' });
    });

    it('returns an error when the named rule does not exist', async () => {
        mockFetch.mockImplementation((req: { url: string; method?: string }) => {
            if (req.url.includes('/alert-rules') && (req.method ?? 'GET') === 'GET') {
                return of({ data: [] });
            }
            return throwError(() => new Error(`unexpected url ${req.url}`));
        });
        const req = parseGrafanaAlertUpdateRequest(prompt)!;
        const result = await runProgrammaticGrafanaAlertUpdate(req, 195);
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/was not found/i);
    });
});
