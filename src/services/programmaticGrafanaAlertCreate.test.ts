import { of, throwError } from 'rxjs';
import { runProgrammaticGrafanaAlertCreate } from './programmaticGrafanaAlertCreate';
import { parseGrafanaAlertCreateRequest } from './grafanaAlertParse';

const mockFetch = jest.fn();

jest.mock('@grafana/runtime', () => ({
    getBackendSrv: () => ({
        fetch: (...args: unknown[]) => mockFetch(...args),
    }),
    config: {
        bootData: { user: { orgId: 1 } },
    },
}));

describe('runProgrammaticGrafanaAlertCreate', () => {
    beforeEach(() => {
        mockFetch.mockReset();
    });

    const prompt =
        'Create a Grafana-managed alert rule for the panel titled "Module 2 Current — Alert Test Own History ±2σ" on the dashboard with UID = afq7tc6hl1m9sb. Reduce the Actual, Upper Bound, and Lower Bound queries using the Last value. Trigger when Actual > Upper Bound OR Actual < Lower Bound. Evaluate every minute. Require the condition to be true for one minute. Send notifications to Alex Test Email.';

    it('creates an alert rule via provisioning API', async () => {
        mockFetch.mockImplementation((req: { url: string; method?: string; data?: unknown }) => {
            if (req.url.includes('/api/dashboards/uid/')) {
                return of({
                    data: {
                        meta: { folderUid: 'folder-keysight' },
                        dashboard: {
                            title: '2505-200033 / Keysight',
                            panels: [
                                {
                                    id: 17,
                                    type: 'timeseries',
                                    title: 'Module 2 Current — Alert Test Own History ±2σ',
                                    datasource: { uid: 'inf1', type: 'influxdb' },
                                    targets: [
                                        {
                                            refId: 'A',
                                            datasource: { uid: 'inf1', type: 'influxdb' },
                                            legendFormat: 'Module 2 (Actual)',
                                            query:
                                                'from(bucket: v.bucket)\n' +
                                                '  |> filter(fn: (r) => r._field == "Module2_Current_A")\n' +
                                                '  |> map(fn: (r) => ({ _time: r._time, _value: r._value, _field: "Module 2 (Actual)" }))\n' +
                                                '  |> keep(columns: ["_time", "_value", "_field"])',
                                            rawQuery: true,
                                        },
                                        {
                                            refId: 'C',
                                            datasource: { uid: 'inf1', type: 'influxdb' },
                                            legendFormat: 'Upper Bound (±2σ)',
                                            query:
                                                'from(bucket: v.bucket)\n' +
                                                '  |> filter(fn: (r) => r._field == "Module2_Current_A")\n' +
                                                '  |> map(fn: (r) => ({ _time: r._time, _value: r.mean + (2.0 * r.std), _field: "Upper Bound (±2σ)" }))\n' +
                                                '  |> keep(columns: ["_time", "_value", "_field"])',
                                            rawQuery: true,
                                        },
                                        {
                                            refId: 'D',
                                            datasource: { uid: 'inf1', type: 'influxdb' },
                                            legendFormat: 'Lower Bound (±2σ)',
                                            query:
                                                'from(bucket: v.bucket)\n' +
                                                '  |> filter(fn: (r) => r._field == "Module2_Current_A")\n' +
                                                '  |> map(fn: (r) => ({ _time: r._time, _value: r.mean - (2.0 * r.std), _field: "Lower Bound (±2σ)" }))\n' +
                                                '  |> keep(columns: ["_time", "_value", "_field"])',
                                            rawQuery: true,
                                        },
                                    ],
                                },
                            ],
                        },
                    },
                });
            }
            if (req.url.includes('/contact-points')) {
                return of({ data: [{ name: 'Alex Test Email', type: 'email', uid: 'cp1' }] });
            }
            if (req.url.includes('/alert-rules') && (req.method ?? 'GET') === 'GET') {
                return of({ data: [] });
            }
            if (req.url.includes('/alert-rules') && req.method === 'POST') {
                const body = req.data as {
                    notification_settings?: { receiver?: string };
                    condition?: string;
                    data?: Array<{ model?: { query?: string } }>;
                };
                expect(body.notification_settings?.receiver).toBe('Alex Test Email');
                expect(body.condition).toBe('H');
                for (const q of body.data ?? []) {
                    const flux = q.model?.query;
                    if (typeof flux === 'string' && flux.includes('from(bucket')) {
                        expect(flux).not.toMatch(/_field:\s*"/);
                        expect(flux).toMatch(/keep\(columns:\s*\["_time",\s*"_value"\]\)/);
                    }
                }
                return of({ data: { uid: 'rule-uid-1', title: 'created' } });
            }
            if (req.url.includes('/rule-groups/')) {
                return of({
                    data: {
                        title: 'graft-afq7tc6hl1m9sb-17',
                        folderUid: 'folder-keysight',
                        interval: 60,
                        rules: [],
                    },
                });
            }
            return throwError(() => new Error(`unexpected url ${req.url}`));
        });

        const req = parseGrafanaAlertCreateRequest(prompt)!;
        const result = await runProgrammaticGrafanaAlertCreate(req, 187);
        expect(result.ok).toBe(true);
        expect(result.ruleUid).toBe('rule-uid-1');
        expect(result.contactPoint).toBe('Alex Test Email');
        expect(result.mathExpression).toBe('$E > $F || $E < $G');
        expect(result.panelId).toBe(17);
        expect(result.alertCompatibleQueries).toBe(true);
    });

    it('updates an existing rule with alert-compatible Flux (PUT)', async () => {
        mockFetch.mockImplementation((req: { url: string; method?: string; data?: unknown }) => {
            if (req.url.includes('/api/dashboards/uid/')) {
                return of({
                    data: {
                        meta: { folderUid: 'folder-keysight' },
                        dashboard: {
                            title: '2505-200033 / Keysight',
                            panels: [
                                {
                                    id: 2,
                                    type: 'timeseries',
                                    title: 'Module 2 Current — Alert Test Own History ±2σ',
                                    datasource: { uid: 'inf1', type: 'influxdb' },
                                    targets: [
                                        {
                                            refId: 'A',
                                            datasource: { uid: 'inf1', type: 'influxdb' },
                                            legendFormat: 'Module 2 (Actual)',
                                            query:
                                                'from(bucket: v.bucket)\n' +
                                                '  |> filter(fn: (r) => r._field == "Module2_Current_A")\n' +
                                                '  |> map(fn: (r) => ({ _time: r._time, _value: r._value, _field: "Module 2 (Actual)" }))\n' +
                                                '  |> keep(columns: ["_time", "_value", "_field"])',
                                            rawQuery: true,
                                        },
                                        {
                                            refId: 'C',
                                            datasource: { uid: 'inf1', type: 'influxdb' },
                                            legendFormat: 'Upper Bound (±2σ)',
                                            query:
                                                'from(bucket: v.bucket)\n' +
                                                '  |> map(fn: (r) => ({ _time: r._time, _value: r.mean + (2.0 * r.std), _field: "Upper" }))\n' +
                                                '  |> keep(columns: ["_time", "_value", "_field"])',
                                            rawQuery: true,
                                        },
                                        {
                                            refId: 'D',
                                            datasource: { uid: 'inf1', type: 'influxdb' },
                                            legendFormat: 'Lower Bound (±2σ)',
                                            query:
                                                'from(bucket: v.bucket)\n' +
                                                '  |> map(fn: (r) => ({ _time: r._time, _value: r.mean - (2.0 * r.std), _field: "Lower" }))\n' +
                                                '  |> keep(columns: ["_time", "_value", "_field"])',
                                            rawQuery: true,
                                        },
                                    ],
                                },
                            ],
                        },
                    },
                });
            }
            if (req.url.includes('/contact-points')) {
                return of({ data: [{ name: 'Alex Test Email', type: 'email', uid: 'cp1' }] });
            }
            if (req.url.includes('/alert-rules') && (req.method ?? 'GET') === 'GET' && !req.url.includes('efs38')) {
                return of({
                    data: [
                        {
                            uid: 'efs38ookomvb4b',
                            title: 'Module 2 Current — Alert Test Own History ±2σ — outside ±2σ',
                            folderUID: 'folder-keysight',
                            ruleGroup: 'graft-afq7tc6hl1m9sb-2',
                            annotations: {
                                __dashboardUid__: 'afq7tc6hl1m9sb',
                                __panelId__: '2',
                            },
                        },
                    ],
                });
            }
            if (req.url.includes('/alert-rules/efs38ookomvb4b') && req.method === 'PUT') {
                const body = req.data as {
                    uid?: string;
                    data?: Array<{ model?: { query?: string } }>;
                };
                expect(body.uid).toBe('efs38ookomvb4b');
                const qA = body.data?.[0]?.model?.query ?? '';
                expect(qA).not.toMatch(/_field:\s*"/);
                expect(qA).toMatch(/keep\(columns:\s*\["_time",\s*"_value"\]\)/);
                return of({ data: { uid: 'efs38ookomvb4b', title: 'updated' } });
            }
            if (req.url.includes('/rule-groups/')) {
                return of({
                    data: {
                        title: 'graft-afq7tc6hl1m9sb-2',
                        folderUid: 'folder-keysight',
                        interval: 60,
                        rules: [],
                    },
                });
            }
            return throwError(() => new Error(`unexpected url ${req.url} method ${req.method}`));
        });

        const req = parseGrafanaAlertCreateRequest(prompt)!;
        const result = await runProgrammaticGrafanaAlertCreate(req, 188);
        expect(result.ok).toBe(true);
        expect(result.updated).toBe(true);
        expect(result.ruleUid).toBe('efs38ookomvb4b');
        expect(result.alertCompatibleQueries).toBe(true);
    });

    it('returns UI guidance when contact point is missing', async () => {
        mockFetch.mockImplementation((req: { url: string }) => {
            if (req.url.includes('/api/dashboards/uid/')) {
                return of({
                    data: {
                        meta: { folderUid: 'folder-keysight' },
                        dashboard: {
                            title: 'Keysight',
                            panels: [
                                {
                                    id: 17,
                                    type: 'timeseries',
                                    title: 'Module 2 Current — Alert Test Own History ±2σ',
                                    datasource: { uid: 'inf1', type: 'influxdb' },
                                    targets: [
                                        {
                                            refId: 'A',
                                            datasource: { uid: 'inf1', type: 'influxdb' },
                                            legendFormat: 'Module 2 (Actual)',
                                            query: 'x',
                                            rawQuery: true,
                                        },
                                        {
                                            refId: 'C',
                                            datasource: { uid: 'inf1', type: 'influxdb' },
                                            legendFormat: 'Upper Bound (±2σ)',
                                            query: 'x',
                                            rawQuery: true,
                                        },
                                        {
                                            refId: 'D',
                                            datasource: { uid: 'inf1', type: 'influxdb' },
                                            legendFormat: 'Lower Bound (±2σ)',
                                            query: 'x',
                                            rawQuery: true,
                                        },
                                    ],
                                },
                            ],
                        },
                    },
                });
            }
            if (req.url.includes('/contact-points')) {
                return of({ data: [{ name: 'Ops Email', type: 'email' }] });
            }
            return throwError(() => new Error(`unexpected url ${req.url}`));
        });

        const req = parseGrafanaAlertCreateRequest(prompt)!;
        const result = await runProgrammaticGrafanaAlertCreate(req, 187);
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/Alex Test Email/);
        expect(result.guidance).toContain('Automatic create failed');
        expect(result.guidance).toContain('Ops Email');
    });

    it('creates a new email contact point when missing and email is provided', async () => {
        const createContactPrompt =
            'Create a Grafana-managed alert for the panel titled "Module 1 Current — Alert Test Own History ±2σ" on the dashboard with UID = idHkqdqnk. Configure the alert to trigger when Module 1 Actual is greater than Upper Bound (±2σ) or less than Lower Bound (±2σ). The condition must remain true for longer than 1 minute before the alert fires. Use Reduce expressions with the Last function for Actual, Upper Bound, and Lower Bound. Create a new email contact point named Alex Test Email using this email address: alex.perry@electramet.com. Configure the alert notification policy so this alert sends notifications to the Alex Test Email contact point.';

        let contactPointCreatePayload: unknown;
        mockFetch.mockImplementation((req: { url: string; method?: string; data?: unknown }) => {
            if (req.url.includes('/api/dashboards/uid/')) {
                return of({
                    data: {
                        meta: { folderUid: 'folder-keysight' },
                        dashboard: {
                            title: 'Keysight',
                            panels: [
                                {
                                    id: 1,
                                    type: 'timeseries',
                                    title: 'Module 1 Current — Alert Test Own History ±2σ',
                                    datasource: { uid: 'inf1', type: 'influxdb' },
                                    targets: [
                                        {
                                            refId: 'A',
                                            datasource: { uid: 'inf1', type: 'influxdb' },
                                            legendFormat: 'Module 1 (Actual)',
                                            query:
                                                'from(bucket: v.bucket)\n' +
                                                '  |> map(fn: (r) => ({ _time: r._time, _value: r._value, _field: "Module 1 (Actual)" }))\n' +
                                                '  |> keep(columns: ["_time", "_value", "_field"])',
                                            rawQuery: true,
                                        },
                                        {
                                            refId: 'C',
                                            datasource: { uid: 'inf1', type: 'influxdb' },
                                            legendFormat: 'Upper Bound (±2σ)',
                                            query:
                                                'from(bucket: v.bucket)\n' +
                                                '  |> map(fn: (r) => ({ _time: r._time, _value: r.mean + (2.0 * r.std), _field: "Upper" }))\n' +
                                                '  |> keep(columns: ["_time", "_value", "_field"])',
                                            rawQuery: true,
                                        },
                                        {
                                            refId: 'D',
                                            datasource: { uid: 'inf1', type: 'influxdb' },
                                            legendFormat: 'Lower Bound (±2σ)',
                                            query:
                                                'from(bucket: v.bucket)\n' +
                                                '  |> map(fn: (r) => ({ _time: r._time, _value: r.mean - (2.0 * r.std), _field: "Lower" }))\n' +
                                                '  |> keep(columns: ["_time", "_value", "_field"])',
                                            rawQuery: true,
                                        },
                                    ],
                                },
                            ],
                        },
                    },
                });
            }
            if (req.url.includes('/contact-points') && (req.method ?? 'GET') === 'GET') {
                return of({ data: [{ name: 'Ops Email', type: 'email' }] });
            }
            if (req.url.includes('/contact-points') && req.method === 'POST') {
                contactPointCreatePayload = req.data;
                return of({ data: { uid: 'cp-new', name: 'Alex Test Email' } });
            }
            if (req.url.includes('/alert-rules') && (req.method ?? 'GET') === 'GET') {
                return of({ data: [] });
            }
            if (req.url.includes('/alert-rules') && req.method === 'POST') {
                const body = req.data as { notification_settings?: { receiver?: string } };
                expect(body.notification_settings?.receiver).toBe('Alex Test Email');
                return of({ data: { uid: 'rule-uid-2', title: 'created' } });
            }
            if (req.url.includes('/rule-groups/')) {
                return of({
                    data: {
                        title: 'graft-idHkqdqnk-1',
                        folderUid: 'folder-keysight',
                        interval: 60,
                        rules: [],
                    },
                });
            }
            return throwError(() => new Error(`unexpected url ${req.url} method ${req.method}`));
        });

        const req = parseGrafanaAlertCreateRequest(createContactPrompt)!;
        const result = await runProgrammaticGrafanaAlertCreate(req, 190);
        expect(result.ok).toBe(true);
        expect(result.contactPoint).toBe('Alex Test Email');
        expect(result.contactPointCreated).toBe(true);
        expect(contactPointCreatePayload).toMatchObject({
            name: 'Alex Test Email',
            type: 'email',
            settings: { addresses: 'alex.perry@electramet.com' },
        });
    });

    it('creates folder + uses custom rule name, group, labels, and annotations', async () => {
        const fullPrompt =
            'Create a Grafana-managed alert named GraftAI Rule for the panel titled "Module 1 Current — Alert Test Own History ±2σ" on the dashboard with UID = idHkqdqnk. Configure the alert to trigger when Module 1 Actual is greater than Upper Bound (±2σ) or less than Lower Bound (±2σ). The condition must remain true for longer than 1 minute before the alert fires. Create a new email contact point named Alex Test Email using this email address: alex.perry@electramet.com. Configure the alert notification policy so this alert sends notifications to the Alex Test Email contact point. Create an Evaluation Group named GraftAI Alert Groups that evaluates every five minutes. Store the rule in a new folder called GraftAI Alert Tests. Add a label with a key of GraftAI Labels and a value of Alex. Make the summary "Module 1 Current Out of Bounds" and the description "Module 1 Actual Value is Outside the Own History". Add a custom annotation name of "Custom Annotation Name" and content of "Custom Annotation Content".';

        let folderCreatePayload: unknown;
        let ruleCreatePayload: {
            title?: string;
            ruleGroup?: string;
            folderUID?: string;
            for?: string;
            labels?: Record<string, string>;
            annotations?: Record<string, string>;
            notification_settings?: { receiver?: string };
        } | undefined;
        let groupPutPayload: { interval?: number; title?: string } | undefined;

        mockFetch.mockImplementation((req: { url: string; method?: string; data?: unknown }) => {
            if (req.url.includes('/api/dashboards/uid/')) {
                return of({
                    data: {
                        meta: { folderUid: 'folder-skywater', folderTitle: 'Skywater' },
                        dashboard: {
                            title: '2103-176030 / Skywater-MN',
                            panels: [
                                {
                                    id: 105,
                                    type: 'timeseries',
                                    title: 'Module 1 Current — Alert Test Own History ±2σ',
                                    datasource: { uid: 'inf1', type: 'influxdb' },
                                    targets: [
                                        {
                                            refId: 'A',
                                            datasource: { uid: 'inf1', type: 'influxdb' },
                                            legendFormat: 'Module 1 (Actual)',
                                            query:
                                                'from(bucket: v.bucket)\n' +
                                                '  |> map(fn: (r) => ({ _time: r._time, _value: r._value, _field: "Module 1 (Actual)" }))\n' +
                                                '  |> keep(columns: ["_time", "_value", "_field"])',
                                            rawQuery: true,
                                        },
                                        {
                                            refId: 'C',
                                            datasource: { uid: 'inf1', type: 'influxdb' },
                                            legendFormat: 'Upper Bound (±2σ)',
                                            query:
                                                'from(bucket: v.bucket)\n' +
                                                '  |> map(fn: (r) => ({ _time: r._time, _value: r.mean + (2.0 * r.std), _field: "Upper" }))\n' +
                                                '  |> keep(columns: ["_time", "_value", "_field"])',
                                            rawQuery: true,
                                        },
                                        {
                                            refId: 'D',
                                            datasource: { uid: 'inf1', type: 'influxdb' },
                                            legendFormat: 'Lower Bound (±2σ)',
                                            query:
                                                'from(bucket: v.bucket)\n' +
                                                '  |> map(fn: (r) => ({ _time: r._time, _value: r.mean - (2.0 * r.std), _field: "Lower" }))\n' +
                                                '  |> keep(columns: ["_time", "_value", "_field"])',
                                            rawQuery: true,
                                        },
                                    ],
                                },
                            ],
                        },
                    },
                });
            }
            if (req.url === '/api/folders' && (req.method ?? 'GET') === 'GET') {
                return of({ data: [{ uid: 'folder-skywater', title: 'Skywater' }] });
            }
            if (req.url === '/api/folders' && req.method === 'POST') {
                folderCreatePayload = req.data;
                return of({ data: { uid: 'folder-graftai', title: 'GraftAI Alert Tests' } });
            }
            if (req.url.includes('/contact-points') && (req.method ?? 'GET') === 'GET') {
                return of({ data: [] });
            }
            if (req.url.includes('/contact-points') && req.method === 'POST') {
                return of({ data: { uid: 'cp-new', name: 'Alex Test Email' } });
            }
            if (req.url.includes('/alert-rules') && (req.method ?? 'GET') === 'GET') {
                return of({ data: [] });
            }
            if (req.url.includes('/alert-rules') && req.method === 'POST') {
                ruleCreatePayload = req.data as typeof ruleCreatePayload;
                return of({ data: { uid: 'rule-graftai', title: 'GraftAI Rule' } });
            }
            if (req.url.includes('/rule-groups/') && (req.method ?? 'GET') === 'GET') {
                return of({
                    data: {
                        title: 'GraftAI Alert Groups',
                        folderUid: 'folder-graftai',
                        interval: 60,
                        rules: [],
                    },
                });
            }
            if (req.url.includes('/rule-groups/') && req.method === 'PUT') {
                groupPutPayload = req.data as { interval?: number; title?: string };
                return of({ data: groupPutPayload });
            }
            return throwError(() => new Error(`unexpected url ${req.url} method ${req.method}`));
        });

        const req = parseGrafanaAlertCreateRequest(fullPrompt)!;
        const result = await runProgrammaticGrafanaAlertCreate(req, 191);
        expect(result.ok).toBe(true);
        expect(result.ruleTitle).toBe('GraftAI Rule');
        expect(result.ruleGroup).toBe('GraftAI Alert Groups');
        expect(result.folderUID).toBe('folder-graftai');
        expect(result.folderTitle).toBe('GraftAI Alert Tests');
        expect(result.folderCreated).toBe(true);
        expect(result.evalIntervalSeconds).toBe(300);
        expect(result.pendingFor).toBe('5m');
        expect(result.pendingAdjusted).toBe(true);
        expect(result.requestedPendingFor).toBe('1m');
        expect(result.summary).toBe('Module 1 Current Out of Bounds');
        expect(folderCreatePayload).toEqual({ title: 'GraftAI Alert Tests' });
        expect(ruleCreatePayload?.title).toBe('GraftAI Rule');
        expect(ruleCreatePayload?.ruleGroup).toBe('GraftAI Alert Groups');
        expect(ruleCreatePayload?.folderUID).toBe('folder-graftai');
        expect(ruleCreatePayload?.for).toBe('5m');
        expect(ruleCreatePayload?.notification_settings?.receiver).toBe('Alex Test Email');
        expect(ruleCreatePayload?.labels?.['GraftAI Labels']).toBe('Alex');
        expect(ruleCreatePayload?.annotations?.summary).toBe('Module 1 Current Out of Bounds');
        expect(ruleCreatePayload?.annotations?.description).toBe(
            'Module 1 Actual Value is Outside the Own History'
        );
        expect(ruleCreatePayload?.annotations?.['Custom Annotation Name']).toBe(
            'Custom Annotation Content'
        );
        expect(groupPutPayload?.interval).toBe(300);
    });
});
