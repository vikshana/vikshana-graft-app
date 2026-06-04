import { readFileSync } from 'fs';
import { join } from 'path';
import { repairInfluxFluxPanel, sanitizeInfluxFluxPanel } from './sanitizeInfluxFluxPanel';

describe('sanitizeInfluxFluxPanel', () => {
    it('fixes boolean rawQuery and removes panel timeFrom/timeTo', () => {
        const raw = JSON.parse(
            readFileSync(
                join(__dirname, '../../scripts/fixtures/panel-module5-randomforest-ml-influx.json'),
                'utf8'
            )
        ) as Record<string, unknown>;
        raw.timeFrom = '2026-05-11T19:00:00Z';
        raw.timeTo = '2026-05-12T19:00:00Z';
        const targets = raw.targets as Record<string, unknown>[];
        targets[0].rawQuery = true;

        const fixed = sanitizeInfluxFluxPanel(raw);
        expect(fixed.timeFrom).toBeUndefined();
        expect(fixed.timeTo).toBeUndefined();
        const a = (fixed.targets as Record<string, unknown>[])[0];
        expect(typeof a.rawQuery).toBe('string');
        expect(a.rawQuery).toBe(a.query);
    });

    it('removes expr and copies datasource from reference Flux panel', () => {
        const panel = {
            targets: [
                {
                    refId: 'A',
                    datasource: { type: 'prometheus', uid: 'x' },
                    query: 'from(bucket: v.bucket)\n  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)',
                    expr: 'from(bucket: v.bucket)\n  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)',
                },
            ],
        };
        const refPanels = [
            {
                title: 'Module 5 peer',
                targets: [
                    {
                        refId: 'A',
                        datasource: { type: 'influxdb', uid: 'influx-uid' },
                        query: 'from(bucket: v.bucket)\n  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)',
                    },
                ],
            },
        ];
        const { panel: fixed, changed, fixes } = repairInfluxFluxPanel(panel, refPanels);
        expect(changed).toBe(true);
        expect((fixed.targets as Record<string, unknown>[])[0].datasource).toEqual({ uid: 'influx-uid' });
        expect((fixed.targets as Record<string, unknown>[])[0].expr).toBeUndefined();
        expect(fixes.some((f) => f.includes('datasource'))).toBe(true);
    });
});
