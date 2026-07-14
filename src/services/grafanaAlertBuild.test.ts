import {
    buildBandBreachAlertQueries,
    classifyActualUpperLowerTargets,
    matchContactPointName,
    parseEvalIntervalSeconds,
    buildProvisionedAlertRuleBody,
} from './grafanaAlertBuild';
import { parseGrafanaAlertCreateRequest } from './grafanaAlertParse';

describe('grafanaAlertBuild', () => {
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
                query: 'from(bucket: v.bucket) |> filter(fn: (r) => r._field == "Module2_Current_A")',
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
                query: 'upper',
                rawQuery: true,
            },
            {
                refId: 'D',
                datasource: { uid: 'influx-uid', type: 'influxdb' },
                legendFormat: 'Lower Bound (±2σ)',
                query: 'lower',
                rawQuery: true,
            },
        ],
    };

    it('classifies Actual / Upper / Lower from legends', () => {
        const c = classifyActualUpperLowerTargets(ownHistoryPanel);
        expect(c?.actualRefId).toBe('A');
        expect(c?.upperRefId).toBe('C');
        expect(c?.lowerRefId).toBe('D');
    });

    it('builds Reduce Last + Math breach queries', () => {
        const built = buildBandBreachAlertQueries(ownHistoryPanel);
        expect('error' in built).toBe(false);
        if ('error' in built) {
            return;
        }
        expect(built.condition).toBe('H');
        expect(built.mathExpression).toBe('$E > $F || $E < $G');
        expect(built.data.map((d) => d.refId)).toEqual(['A', 'C', 'D', 'E', 'F', 'G', 'H']);
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
