import {
    formatPeerRfUnavailableExplanation,
    probePeerRfModelAvailability,
    rankInfluxDatasourcesForPeerRf,
} from './peerRfModelAvailability';

const fetchMock = jest.fn();

jest.mock('@grafana/runtime', () => ({
    getBackendSrv: () => ({
        fetch: (...args: unknown[]) => fetchMock(...args),
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

describe('peerRfModelAvailability', () => {
    beforeEach(() => {
        fetchMock.mockReset();
    });

    it('reports available when count frame has a positive value', async () => {
        fetchMock.mockImplementation((opts: { url: string }) => {
            if (opts.url.includes('/api/datasources/uid/')) {
                return ofData({ jsonData: { defaultBucket: 'powertechdata' } });
            }
            return ofData({
                results: {
                    A: {
                        frames: [{ data: { values: [[1]] } }],
                    },
                },
            });
        });
        const r = await probePeerRfModelAvailability({
            influxDatasourceUid: 'inf1',
            machineId: '2406-176021',
            moduleNumber: 2,
        });
        expect(r.available).toBe(true);
        expect(r.bucket).toBe('powertechdata');
        expect(r.field).toBe('Module2_Current_A');
    });

    it('reports unavailable when Influx returns empty frames', async () => {
        fetchMock.mockImplementation((opts: { url: string }) => {
            if (opts.url.includes('/api/datasources/uid/')) {
                return ofData({ jsonData: { defaultBucket: 'powertechdata' } });
            }
            return ofData({ results: { A: { frames: [{ data: { values: [[0]] } }] } } });
        });
        const r = await probePeerRfModelAvailability({
            influxDatasourceUid: 'inf1',
            machineId: '2505-200033',
            moduleNumber: 2,
        });
        expect(r.available).toBe(false);
        expect(r.probeError).toBeUndefined();
    });

    it('formats an operator explanation without inventing a panel', () => {
        const text = formatPeerRfUnavailableExplanation({
            machineId: '2505-200033',
            moduleNumber: 2,
            field: 'Module2_Current_A',
        });
        expect(text).toContain('auto-enrolls');
        expect(text).toContain('2505-200033');
        expect(text).toContain('will **not** create placeholder');
        expect(text).toContain('vs. Peer Band');
    });

    it('ranks remote Influx ahead of docker-local influxdb:8086', () => {
        const ranked = rankInfluxDatasourcesForPeerRf([
            { uid: 'local', url: 'https://influxdb:8086', isDefault: true },
            { uid: 'remote', url: 'https://52.35.251.91:8086' },
        ]);
        expect(ranked[0]).toBe('remote');
        expect(ranked[1]).toBe('local');
    });
});
