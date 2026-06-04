import { applyFluxFixesToPanel, sanitizeFluxQueryString } from './fluxQueryFix';

describe('sanitizeFluxQueryString', () => {
    it('fixes stdDev and mean_val and group(by:', () => {
        const q = 'data |> mean() |> stdDev() |> group(by: ["x"]) |> mean_val';
        const { query, changed } = sanitizeFluxQueryString(q);
        expect(changed).toBe(true);
        expect(query).toContain('stddev');
        expect(query).toContain('mean');
        expect(query).not.toContain('stdDev');
        expect(query).not.toContain('mean_val');
        expect(query).toContain('group(columns: [');
    });
});

describe('applyFluxFixesToPanel', () => {
    it('updates influx targets only', () => {
        const panel = {
            id: 35,
            targets: [
                {
                    refId: 'B',
                    datasource: { type: 'influxdb' },
                    query: 'from() |> stdDev()',
                },
                {
                    refId: 'A',
                    datasource: { type: 'prometheus' },
                    expr: 'up',
                },
            ],
        };
        const { changed, targetsFixed } = applyFluxFixesToPanel(panel);
        expect(changed).toBe(true);
        expect(targetsFixed).toBe(1);
    });
});
