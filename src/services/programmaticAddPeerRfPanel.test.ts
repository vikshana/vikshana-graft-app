import { runProgrammaticAddPeerRfPanel, formatAddPeerRfPanelReply } from './programmaticAddPeerRfPanel';

interface SavedPanel {
    title?: string;
    targets?: Array<{ query?: string }>;
}

const fetchMock = jest.fn();
const getMock = jest.fn();
const postMock = jest.fn();

jest.mock('@grafana/runtime', () => ({
    getBackendSrv: () => ({
        fetch: (...args: unknown[]) => fetchMock(...args),
        get: (...args: unknown[]) => getMock(...args),
        post: (...args: unknown[]) => postMock(...args),
    }),
}));

function ofData<T>(data: T) {
    return {
        subscribe(observer: { next: (v: unknown) => void; complete: () => void }) {
            observer.next({ data });
            observer.complete();
            return { unsubscribe() {} };
        },
    };
}

/** Default: peer_rf bands exist so create can proceed. */
function mockPeerRfAvailable(available: boolean) {
    getMock.mockResolvedValue({ ok: false, controlConfigured: false });
    postMock.mockResolvedValue({});
    fetchMock.mockImplementation((opts: { url: string }) => {
        if (opts.url === '/api/datasources' || opts.url.endsWith('/api/datasources')) {
            return ofData([
                {
                    type: 'influxdb',
                    uid: 'ffmk2neut49vkf',
                    name: 'InfluxDB',
                    url: 'https://52.35.251.91:8086',
                    isDefault: true,
                },
            ]);
        }
        if (opts.url.includes('/api/datasources/uid/')) {
            return ofData({ jsonData: { defaultBucket: 'powertechdata' } });
        }
        if (opts.url.includes('/api/ds/query')) {
            return ofData({
                results: {
                    A: {
                        frames: [{ data: { values: [[available ? 12 : 0]] } }],
                    },
                },
            });
        }
        return ofData({});
    });
}

function fluxRef(title: string, field: string) {
    return {
        id: 1,
        title,
        type: 'timeseries',
        gridPos: { x: 0, y: 0, w: 24, h: 10 },
        datasource: { type: 'influxdb', uid: 'ffmk2neut49vkf' },
        targets: [
            {
                refId: 'A',
                datasource: { type: 'influxdb', uid: 'ffmk2neut49vkf' },
                rawQuery: true,
                query: `from(bucket: v.bucket)\n  |> filter(fn: (r) => r.machine == "2406-176021" and r._field == "${field}")`,
            },
        ],
    };
}

function client(
    capture: { saved?: { panels?: SavedPanel[] } },
    opts?: { panels?: unknown[]; listDatasources?: Array<{ uid: string; type: string; name: string }> }
) {
    const dashboard = {
        uid: 'afq7tc6hl1m9sb',
        title: '2505-200033 / Keysight',
        version: 7,
        panels: opts?.panels ?? [fluxRef('Module 5 Current — vs. Peer Band (Modules 1–4,6–8 Avg ± 2σ)', 'Module5_Current_A')],
    };
    return {
        callTool: jest.fn(async ({ name, arguments: args }: { name: string; arguments: unknown }) => {
            if (name === 'get_dashboard_by_uid') {
                return { content: [{ type: 'text', text: JSON.stringify({ dashboard }) }] };
            }
            if (name === 'list_datasources') {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                opts?.listDatasources ?? [
                                    { uid: 'prom-1', type: 'prometheus', name: 'Prometheus' },
                                    { uid: 'influx-from-grafana', type: 'influxdb', name: 'InfluxDB' },
                                ]
                            ),
                        },
                    ],
                };
            }
            if (name === 'update_dashboard') {
                capture.saved = (args as { dashboard?: { panels?: SavedPanel[] } }).dashboard;
                return { content: [{ type: 'text', text: JSON.stringify({ uid: dashboard.uid, version: 8 }) }] };
            }
            throw new Error(`unexpected tool ${name}`);
        }),
    };
}

describe('runProgrammaticAddPeerRfPanel — module scope', () => {
    beforeEach(() => {
        fetchMock.mockReset();
        mockPeerRfAvailable(true);
    });

    it('creates a panel for the requested module (3), not Module 5', async () => {
        const capture: { saved?: { panels?: SavedPanel[] } } = {};
        const result = await runProgrammaticAddPeerRfPanel(client(capture), {
            dashboardUid: 'afq7tc6hl1m9sb',
            machineId: '2505-200033',
            moduleNumber: 3,
        });
        expect(result.ok).toBe(true);
        expect(result.panelTitle).toBe('Module 3 Current — RandomForest vs Peers (Influx)');
        const added = capture.saved?.panels?.find((p) => p.title?.includes('RandomForest vs Peers'));
        const blob = JSON.stringify(added);
        expect(blob).toContain('Module3_Current_A');
        expect(blob).not.toContain('Module5_Current_A');
        expect(blob).toContain('Module 3 (Actual)');
        expect(blob).toContain('2505-200033');
    });

    it('requires an explicit module (does not invent Module 5)', async () => {
        const capture: { saved?: { panels?: SavedPanel[] } } = {};
        const result = await runProgrammaticAddPeerRfPanel(client(capture), {
            dashboardUid: 'afq7tc6hl1m9sb',
            machineId: '2505-200033',
        });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/Which module/i);
    });

    it('uses machine id from Keysight dashboard title when request omits machineId', async () => {
        const capture: { saved?: { panels?: SavedPanel[] } } = {};
        const result = await runProgrammaticAddPeerRfPanel(client(capture), {
            dashboardUid: 'afq7tc6hl1m9sb',
            moduleNumber: 2,
        });
        expect(result.ok).toBe(true);
        expect(result.machineId).toBe('2505-200033');
        const added = capture.saved?.panels?.find((p) => p.title?.includes('RandomForest vs Peers'));
        const blob = JSON.stringify(added);
        expect(blob).toContain('2505-200033');
        expect(blob).not.toContain('2406-176021');
        expect(blob).toContain('Module2_Current_A');
        expect(added?.targets?.length).toBe(4);
        expect(added?.targets?.every((t) => Boolean(t.query))).toBe(true);
    });

    it('resolves Influx via list_datasources when Keysight has only Prometheus panels', async () => {
        const capture: { saved?: { panels?: SavedPanel[] } } = {};
        const result = await runProgrammaticAddPeerRfPanel(
            client(capture, {
                panels: [
                    {
                        id: 1,
                        title: 'Pressure',
                        type: 'timeseries',
                        datasource: { type: 'prometheus', uid: 'prom-1' },
                        targets: [
                            {
                                refId: 'A',
                                datasource: { type: 'prometheus', uid: 'prom-1' },
                                expr: 'machine_metrics{machine="2505-200033",field="Pressure1_psi"}',
                            },
                        ],
                    },
                ],
            }),
            { dashboardUid: 'afq7tc6hl1m9sb', moduleNumber: 2 }
        );
        expect(result.ok).toBe(true);
        const added = capture.saved?.panels?.find((p) => p.title?.includes('RandomForest vs Peers'));
        const blob = JSON.stringify(added);
        expect(blob).toContain('ffmk2neut49vkf');
        expect(blob).toContain('2505-200033');
        expect(blob).toContain('Module2_Current_A');
        expect(added?.targets?.length).toBe(4);
    });

    it('explains and does not save when peer_rf bands are missing for the machine', async () => {
        mockPeerRfAvailable(false);
        const capture: { saved?: { panels?: SavedPanel[] } } = {};
        const result = await runProgrammaticAddPeerRfPanel(client(capture), {
            dashboardUid: 'afq7tc6hl1m9sb',
            moduleNumber: 2,
        });
        expect(result.ok).toBe(false);
        expect(result.unavailableReason).toBe('peer_rf_missing');
        expect(result.error).toMatch(/RandomForest|Peer Band|Own History/i);
        expect(capture.saved).toBeUndefined();
        const reply = formatAddPeerRfPanelReply(result, 209);
        expect(reply).toContain('RandomForest vs Peers is not ready yet');
        expect(reply).toContain('No panel was added');
    });

    it('auto-enrolls when control is configured and bands appear after wait', async () => {
        let probeCount = 0;
        getMock.mockImplementation(async (url: string) => {
            if (url.includes('/peer-rf/health')) {
                return { ok: true, controlConfigured: true };
            }
            if (url.includes('/peer-rf/machines/')) {
                return {
                    enrolled: true,
                    backfill: { running: false, finishedAt: '2026-07-31T20:00:00Z' },
                };
            }
            return {};
        });
        postMock.mockResolvedValue({
            ok: true,
            machineId: '2505-200033',
            alreadyEnrolled: true,
            backfillQueued: true,
        });
        fetchMock.mockImplementation((opts: { url: string }) => {
            if (opts.url === '/api/datasources' || opts.url.endsWith('/api/datasources')) {
                return ofData([
                    {
                        type: 'influxdb',
                        uid: 'ffmk2neut49vkf',
                        name: 'InfluxDB',
                        url: 'https://52.35.251.91:8086',
                        isDefault: true,
                    },
                ]);
            }
            if (opts.url.includes('/api/datasources/uid/')) {
                return ofData({ jsonData: { defaultBucket: 'powertechdata' } });
            }
            if (opts.url.includes('/api/ds/query')) {
                probeCount += 1;
                // Unavailable until enroll path re-probes (probeCount grows past initial resolve).
                return ofData({
                    results: {
                        A: {
                            frames: [{ data: { values: [[probeCount >= 3 ? 8 : 0]] } }],
                        },
                    },
                });
            }
            return ofData({});
        });

        const capture: { saved?: { panels?: SavedPanel[] } } = {};
        const result = await runProgrammaticAddPeerRfPanel(client(capture), {
            dashboardUid: 'afq7tc6hl1m9sb',
            moduleNumber: 2,
        });
        expect(postMock).toHaveBeenCalled();
        expect(result.ok).toBe(true);
        expect(capture.saved?.panels?.some((p) => p.title?.includes('RandomForest vs Peers'))).toBe(true);
    });
});
