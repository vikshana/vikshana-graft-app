import { readFileSync } from 'fs';
import { join } from 'path';
import {
    ensureFluxTargetLegendOverrides,
    hasFrameRefIdLegendOverrides,
    repairInfluxFluxPanel,
    sanitizeInfluxFluxPanel,
} from './sanitizeInfluxFluxPanel';

describe('sanitizeInfluxFluxPanel', () => {
    it('fixes boolean rawQuery and removes panel timeFrom/timeTo', () => {
        const raw = JSON.parse(
            readFileSync(
                join(__dirname, '../../scripts/fixtures/panel-module5-randomforest-ml-influx.json'),
                'utf8'
            )
        ) as Record<string, unknown>;
        raw.timeFrom = '2020-06-01T12:00:00Z';
        raw.timeTo = '2020-06-02T12:00:00Z';
        const targets = raw.targets as Record<string, unknown>[];
        targets[0].rawQuery = true;

        const fixed = sanitizeInfluxFluxPanel(raw);
        expect(fixed.timeFrom).toBeUndefined();
        expect(fixed.timeTo).toBeUndefined();
        const a = (fixed.targets as Record<string, unknown>[])[0];
        expect(a.rawQuery).toBe(true);
        expect(typeof a.query).toBe('string');
        expect(a.expr).toBeUndefined();
    });

    it('fixes expr-only RandomForest targets (query field + rawQuery true)', () => {
        const panel = {
            datasource: { type: 'influxdb', uid: 'ffmk2neut49vkf' },
            targets: [
                {
                    refId: 'A',
                    datasource: { type: 'influxdb', uid: 'ffmk2neut49vkf' },
                    editorMode: 'code',
                    expr: 'from(bucket: v.bucket)\n  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)',
                    rawQuery:
                        'from(bucket: v.bucket)\n  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)',
                },
            ],
        };
        const fixed = sanitizeInfluxFluxPanel(panel);
        const a = (fixed.targets as Record<string, unknown>[])[0];
        expect(a.expr).toBeUndefined();
        expect(a.rawQuery).toBe(true);
        expect(typeof a.query).toBe('string');
        expect(String(a.query)).toContain('from(bucket: v.bucket)');
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
        // The full datasource ref (type + uid) is copied from the reference panel.
        expect((fixed.targets as Record<string, unknown>[])[0].datasource).toEqual({
            type: 'influxdb',
            uid: 'influx-uid',
        });
        expect((fixed.targets as Record<string, unknown>[])[0].expr).toBeUndefined();
        expect(fixes.some((f) => f.includes('datasource'))).toBe(true);
    });

    it('replaces set(_field) with map(_field) for Grafana legend names', () => {
        const panel = {
            title: 'Module 5 Current — RandomForest ML (Influx)',
            targets: [
                {
                    refId: 'A',
                    datasource: { uid: 'influx-uid' },
                    query:
                        'from(bucket: v.bucket)\n  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)\n  |> set(key: "_field", value: "Module 5 (Actual)")',
                    rawQuery: true,
                },
            ],
        };
        const { panel: fixed, fixes } = repairInfluxFluxPanel(panel);
        const a = (fixed.targets as Record<string, unknown>[])[0];
        expect(String(a.query)).toContain('map(fn: (r) =>');
        expect(String(a.query)).not.toContain('set(key: "_field"');
        expect(a.legendFormat).toBe('Module 5 (Actual)');
        expect(fixes.some((f) => f.includes('legend label'))).toBe(true);
    });

    it('canonicalizes legend suffix without duplicating map/keep lines', () => {
        const panel = {
            title: 'Module 4 Current — RandomForest vs Peers (Influx)',
            targets: [
                {
                    refId: 'A',
                    datasource: { uid: 'influx-uid' },
                    query:
                        'from(bucket: v.bucket)\n  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)\n  |> keep(columns: ["_time", "_value"])\n  |> map(fn: (r) => ({ _time: r._time, _value: r._value, _field: "Module 4 (Actual)" }))\n  |> map(fn: (r) => ({ r with _field: "Module 4 (Actual)" }))\n  |> keep(columns: ["_time", "_value", "_field"])\n  |> map(fn: (r) => ({ r with _field: "Module 4 (Actual)" }))\n  |> keep(columns: ["_time", "_value", "_field"])',
                    rawQuery: true,
                    legendFormat: 'Module 4 (Actual)',
                },
            ],
        };
        const { panel: fixed, changed, fixes } = repairInfluxFluxPanel(panel);
        expect(changed).toBe(true);
        const q = String((fixed.targets as Record<string, unknown>[])[0].query);
        expect((q.match(/map\(fn:/g) ?? []).length).toBe(2);
        expect((q.match(/keep\(columns: \["_time", "_value", "_field"\]/g) ?? []).length).toBe(1);
        expect(q).toContain('_time: r._time');
        expect(q).toContain('r with _field');
        expect(fixes.some((f) => f.includes('legend label'))).toBe(true);

        const { changed: changedAgain } = repairInfluxFluxPanel(fixed);
        expect(changedAgain).toBe(false);
    });

    it('adds byFrameRefID displayName overrides for RandomForest panels', () => {
        const panel = {
            title: 'Module 5 Current — RandomForest ML (Influx)',
            fieldConfig: { defaults: {}, overrides: [] },
            targets: [
                { refId: 'A', query: 'from(bucket: v.bucket)', rawQuery: true, legendFormat: 'Module 5 (Actual)' },
                { refId: 'B', query: 'from(bucket: v.bucket)', rawQuery: true, legendFormat: 'Upper Bound (RF)' },
            ],
        };
        expect(ensureFluxTargetLegendOverrides(panel)).toBe(true);
        expect(hasFrameRefIdLegendOverrides(panel)).toBe(true);
        const overrides = (panel.fieldConfig as { overrides: { matcher: { id: string }; properties: { id: string }[] }[] })
            .overrides;
        expect(overrides.some((o) => o.matcher.id === 'byFrameRefID' && o.properties.some((p) => p.id === 'displayName'))).toBe(
            true
        );
    });
});
