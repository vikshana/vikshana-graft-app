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
});
