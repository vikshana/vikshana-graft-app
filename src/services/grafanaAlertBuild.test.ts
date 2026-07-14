import {
    buildBandBreachAlertQueries,
    classifyActualUpperLowerTargets,
    matchContactPointName,
    parseEvalIntervalSeconds,
    buildProvisionedAlertRuleBody,
    makeFluxQueryAlertCompatible,
    fluxQueryEmitsFieldLabel,
} from './grafanaAlertBuild';
import { parseGrafanaAlertCreateRequest } from './grafanaAlertParse';

describe('grafanaAlertBuild', () => {
    const actualFlux =
        'from(bucket: v.bucket)\n' +
        '  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)\n' +
        '  |> filter(fn: (r) => r.machine == "2505-200033" and r._field == "Module2_Current_A")\n' +
        '  |> aggregateWindow(every: v.windowPeriod, fn: mean, createEmpty: false)\n' +
        '  |> map(fn: (r) => ({ _time: r._time, _value: r._value, _field: "Module 2 (Actual)" }))\n' +
        '  |> map(fn: (r) => ({ r with _field: "Module 2 (Actual)" }))\n' +
        '  |> keep(columns: ["_time", "_value", "_field"])';

    const upperFlux =
        'base = from(bucket: v.bucket)\n' +
        '  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)\n' +
        '  |> filter(fn: (r) => r.machine == "2505-200033" and r._field == "Module2_Current_A")\n' +
        '  |> group()\n\n' +
        'meanTable = base\n' +
        '  |> aggregateWindow(every: 1h, fn: mean, createEmpty: false)\n' +
        '  |> set(key: "stat", value: "mean")\n\n' +
        'stdTable = base\n' +
        '  |> aggregateWindow(every: 1h, fn: stddev, createEmpty: false)\n' +
        '  |> set(key: "stat", value: "std")\n\n' +
        'union(tables: [meanTable, stdTable])\n' +
        '  |> pivot(rowKey: ["_time"], columnKey: ["stat"], valueColumn: "_value")\n' +
        '  |> map(fn: (r) => ({ _time: r._time, _value: r.mean + (2.0 * r.std), _field: "Upper Bound (±2σ)" }))\n' +
        '  |> keep(columns: ["_time", "_value", "_field"])';

    const lowerFlux =
        'base = from(bucket: v.bucket)\n' +
        '  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)\n' +
        '  |> filter(fn: (r) => r.machine == "2505-200033" and r._field == "Module2_Current_A")\n' +
        '  |> group()\n\n' +
        'meanTable = base\n' +
        '  |> aggregateWindow(every: 1h, fn: mean, createEmpty: false)\n' +
        '  |> set(key: "stat", value: "mean")\n\n' +
        'stdTable = base\n' +
        '  |> aggregateWindow(every: 1h, fn: stddev, createEmpty: false)\n' +
        '  |> set(key: "stat", value: "std")\n\n' +
        'union(tables: [meanTable, stdTable])\n' +
        '  |> pivot(rowKey: ["_time"], columnKey: ["stat"], valueColumn: "_value")\n' +
        '  |> map(fn: (r) => ({ _time: r._time, _value: r.mean - (2.0 * r.std), _field: "Lower Bound (±2σ)" }))\n' +
        '  |> keep(columns: ["_time", "_value", "_field"])';

    const ownHistoryPanel = {
        id: 42,
        type: 'timeseries',
        title: 'Module 2 Current — Alert Test Own History ±2σ',
        datasource: { uid: 'influx-uid', type: 'influxdb' },
        targets: [
            {
                refId: 'A',
                datasource: { uid: 'influx-uid', type: 'influxdb' },
                legendFormat: 'Module 2 (Actual)',
                query: actualFlux,
                rawQuery: true,
            },
            {
                refId: 'B',
                datasource: { uid: 'influx-uid', type: 'influxdb' },
                legendFormat: 'Historical Mean',
                query: 'mean',
                rawQuery: true,
            },
            {
                refId: 'C',
                datasource: { uid: 'influx-uid', type: 'influxdb' },
                legendFormat: 'Upper Bound (±2σ)',
                query: upperFlux,
                rawQuery: true,
            },
            {
                refId: 'D',
                datasource: { uid: 'influx-uid', type: 'influxdb' },
                legendFormat: 'Lower Bound (±2σ)',
                query: lowerFlux,
                rawQuery: true,
            },
        ],
    };

    it('rewrites panel Flux to alert-compatible _time/_value (no output _field labels)', () => {
        expect(fluxQueryEmitsFieldLabel(actualFlux)).toBe(true);
        expect(fluxQueryEmitsFieldLabel(upperFlux)).toBe(true);

        const a = makeFluxQueryAlertCompatible(actualFlux);
        const u = makeFluxQueryAlertCompatible(upperFlux);
        const l = makeFluxQueryAlertCompatible(lowerFlux);

        expect(fluxQueryEmitsFieldLabel(a)).toBe(false);
        expect(fluxQueryEmitsFieldLabel(u)).toBe(false);
        expect(fluxQueryEmitsFieldLabel(l)).toBe(false);

        // Selection filters may still reference Influx schema r._field == "Module2_…"
        expect(a).toMatch(/r\._field\s*==\s*"Module2_Current_A"/);
        expect(a).toMatch(/keep\(columns:\s*\["(_time|_value)",\s*"(_time|_value)"\]\)/);
        expect(a).not.toMatch(/_field:\s*"/);
        expect(u).toContain('r.mean + (2.0 * r.std)');
        expect(u).not.toMatch(/_field:\s*"/);
        expect(l).toContain('r.mean - (2.0 * r.std)');
    });

    it('classifies Actual / Upper / Lower from legends', () => {
        const c = classifyActualUpperLowerTargets(ownHistoryPanel);
        expect(c?.actualRefId).toBe('A');
        expect(c?.upperRefId).toBe('C');
        expect(c?.lowerRefId).toBe('D');
    });

    it('builds Reduce Last + Math breach queries with rewritten Flux', () => {
        const built = buildBandBreachAlertQueries(ownHistoryPanel);
        expect('error' in built).toBe(false);
        if ('error' in built) {
            return;
        }
        expect(built.condition).toBe('H');
        expect(built.mathExpression).toBe('$E > $F || $E < $G');
        expect(built.data.map((d) => d.refId)).toEqual(['A', 'C', 'D', 'E', 'F', 'G', 'H']);
        for (const q of built.data.slice(0, 3)) {
            const flux = String(q.model.query ?? '');
            expect(fluxQueryEmitsFieldLabel(flux)).toBe(false);
            expect(q.model.legendFormat).toBeUndefined();
        }
        expect(built.data[3].model.type).toBe('reduce');
        expect(built.data[3].model.expression).toBe('A');
        expect(built.data[3].model.reducer).toBe('last');
        expect(built.data[6].model.type).toBe('math');
        expect(built.data[0].datasourceUid).toBe('influx-uid');
        expect(built.data[3].datasourceUid).toBe('-100');
    });

    it('matches contact point names case-insensitively', () => {
        expect(
            matchContactPointName([{ name: 'Alex Test Email' }, { name: 'PagerDuty' }], 'alex test email')
        ).toBe('Alex Test Email');
    });

    it('parses evaluate every minute as 60s', () => {
        expect(parseEvalIntervalSeconds('1m')).toBe(60);
        expect(parseEvalIntervalSeconds(undefined)).toBe(60);
    });

    it('includes notification_settings.receiver and panel annotations', () => {
        const req = parseGrafanaAlertCreateRequest(
            'Create a Grafana-managed alert rule for the panel titled "Module 2 Current — Alert Test Own History ±2σ" on the dashboard with UID = afq7tc6hl1m9sb. Evaluate every minute. Require the condition to be true for one minute. Send notifications to Alex Test Email.'
        )!;
        const built = buildBandBreachAlertQueries(ownHistoryPanel);
        if ('error' in built) {
            throw new Error(built.error);
        }
        const body = buildProvisionedAlertRuleBody({
            request: req,
            title: 'Module 2 Current — Alert Test Own History ±2σ — outside ±2σ',
            ruleGroup: 'graft-afq7tc6hl1m9sb-42',
            folderUID: 'folder-1',
            orgId: 1,
            panelId: 42,
            dashboardUid: 'afq7tc6hl1m9sb',
            data: built.data,
            condition: built.condition,
            contactPointName: 'Alex Test Email',
        });
        expect(body.for).toBe('1m');
        expect(body.notification_settings).toEqual({ receiver: 'Alex Test Email' });
        expect((body.annotations as Record<string, string>).__dashboardUid__).toBe('afq7tc6hl1m9sb');
        expect((body.annotations as Record<string, string>).__panelId__).toBe('42');
    });
});
