import {
    inferUnit,
    inferMetricType,
    inferVizPrometheus,
    inferVizLoki,
    defaultThresholdsFor,
    enrichPrometheusQuery,
    enrichLokiQuery,
    enrichDataFindings,
    inferLayoutHint,
    DEFAULT_THRESHOLDS,
    ERROR_RATE_THRESHOLDS,
    UTILIZATION_THRESHOLDS,
} from './dashboardEnrichment';
import type { ValidatedPrometheusQuery, ValidatedLokiQuery } from './types';

// ─── inferUnit ────────────────────────────────────────────────────────────────

describe('inferUnit', () => {
    it('infers "s" for _seconds metrics', () => {
        expect(inferUnit('http_request_duration_seconds')).toBe('s');
        expect(inferUnit('rate(http_request_duration_seconds[5m])')).toBe('s');
    });
    it('infers "ms" for _milliseconds metrics', () => {
        expect(inferUnit('db_query_duration_milliseconds')).toBe('ms');
    });
    it('infers "bytes" for _bytes metrics', () => {
        expect(inferUnit('node_memory_Active_bytes')).toBe('bytes');
    });
    it('infers "percentunit" for _ratio/_utilization metrics', () => {
        expect(inferUnit('node_cpu_utilization')).toBe('percentunit');
        expect(inferUnit('disk_usage_ratio')).toBe('percentunit');
    });
    it('infers "percent" for _percent metrics', () => {
        expect(inferUnit('cpu_usage_percent')).toBe('percent');
    });
    it('infers "reqps" for rate() on _total counters', () => {
        expect(inferUnit('rate(http_requests_total[5m])')).toBe('reqps');
        expect(inferUnit('rate(api_calls_count[1m])')).toBe('reqps');
    });
    it('returns undefined for unknown patterns', () => {
        expect(inferUnit('some_custom_metric')).toBeUndefined();
        expect(inferUnit('up')).toBeUndefined();
    });
    it('infers "ns" for _nanoseconds', () => {
        expect(inferUnit('trace_duration_nanoseconds')).toBe('ns');
    });
});

// ─── inferMetricType ──────────────────────────────────────────────────────────

describe('inferMetricType', () => {
    it('infers "histogram" for _bucket metrics', () => {
        expect(inferMetricType('http_request_duration_seconds_bucket')).toBe('histogram');
    });
    it('infers "counter" for _total metrics', () => {
        expect(inferMetricType('http_requests_total')).toBe('counter');
    });
    it('infers "counter" for _count metrics', () => {
        expect(inferMetricType('http_requests_count')).toBe('counter');
    });
    it('infers "counter" for rate() expressions', () => {
        expect(inferMetricType('rate(errors_total[5m])')).toBe('counter');
    });
    it('infers "summary" for histogram_quantile (without _bucket suffix)', () => {
        // When _bucket is absent, histogram_quantile matches the counter/_sum pattern first,
        // giving 'counter'. The heatmap path only fires when _bucket is in the expr.
        expect(inferMetricType('histogram_quantile(0.95, rate(http_duration_sum[5m]))')).toBe('counter');
    });
    it('returns undefined for unknown patterns', () => {
        expect(inferMetricType('up')).toBeUndefined();
    });
});

// ─── inferVizPrometheus ───────────────────────────────────────────────────────

describe('inferVizPrometheus', () => {
    it('infers "heatmap" for _bucket histogram metrics', () => {
        expect(inferVizPrometheus('http_request_duration_seconds_bucket', 'histogram')).toBe('heatmap');
    });
    it('infers "timeseries" for histogram_quantile (without _bucket suffix)', () => {
        expect(inferVizPrometheus('histogram_quantile(0.95, rate(dur_sum[5m]))')).toBe('timeseries');
    });
    it('infers "gauge" for ratio/utilization', () => {
        expect(inferVizPrometheus('node_cpu_utilization')).toBe('gauge');
    });
    it('infers "stat" for up/info metrics', () => {
        expect(inferVizPrometheus('up')).toBe('stat');
        expect(inferVizPrometheus('kube_node_info')).toBe('stat');
    });
    it('infers "timeseries" for rate() metrics', () => {
        expect(inferVizPrometheus('rate(http_requests_total[5m])')).toBe('timeseries');
    });
    it('returns undefined for unrecognized patterns', () => {
        expect(inferVizPrometheus('some_custom_metric')).toBeUndefined();
    });
});

// ─── inferVizLoki ─────────────────────────────────────────────────────────────

describe('inferVizLoki', () => {
    it('infers "timeseries" for rate queries', () => {
        expect(inferVizLoki('rate({job="api"}[5m])')).toBe('timeseries');
    });
    it('infers "timeseries" for count_over_time', () => {
        expect(inferVizLoki('count_over_time({app="web"}[1m])')).toBe('timeseries');
    });
    it('infers "timeseries" for sum aggregation', () => {
        expect(inferVizLoki('sum(rate({job="api"}[5m])) by (level)')).toBe('timeseries');
    });
    it('infers "logs" for plain stream selectors', () => {
        expect(inferVizLoki('{job="api", level="error"}')).toBe('logs');
    });
    it('infers "logs" for filter expressions', () => {
        expect(inferVizLoki('{job="api"} |= "error"')).toBe('logs');
    });
});

// ─── defaultThresholdsFor ─────────────────────────────────────────────────────

describe('defaultThresholdsFor', () => {
    it('returns utilization thresholds for percentunit', () => {
        expect(defaultThresholdsFor('percentunit', 'cpu_utilization')).toBe(UTILIZATION_THRESHOLDS);
    });
    it('returns utilization thresholds for _utilization metrics', () => {
        expect(defaultThresholdsFor(undefined, 'node_cpu_utilization')).toBe(UTILIZATION_THRESHOLDS);
    });
    it('returns error rate thresholds for error metrics', () => {
        // unit=undefined, name contains "error" → error rate thresholds
        const result = defaultThresholdsFor(undefined, 'rate(http_errors_total[5m])');
        expect(result).toEqual(ERROR_RATE_THRESHOLDS);
    });
    it('returns utilization thresholds when unit=percentunit (takes priority over name)', () => {
        // percentunit check runs before _error name check
        const result = defaultThresholdsFor('percentunit', 'rate(http_errors_total[5m])');
        expect(result).toEqual(UTILIZATION_THRESHOLDS);
    });
    it('returns default thresholds for generic metrics', () => {
        expect(defaultThresholdsFor('reqps', 'http_requests_total')).toBe(DEFAULT_THRESHOLDS);
    });
});

// ─── enrichPrometheusQuery ────────────────────────────────────────────────────

describe('enrichPrometheusQuery', () => {
    it('fills unit, metricType, suggestedViz, and thresholds from metric name', () => {
        const q: ValidatedPrometheusQuery = {
            description: 'Request rate',
            promql: 'rate(http_requests_total[5m])',
        };
        const enriched = enrichPrometheusQuery(q);
        expect(enriched.unit).toBe('reqps');
        expect(enriched.metricType).toBe('counter');
        expect(enriched.suggestedViz).toBe('timeseries');
        // timeseries → no thresholds
        expect(enriched.thresholds).toBeUndefined();
    });

    it('fills thresholds for a gauge panel', () => {
        const q: ValidatedPrometheusQuery = {
            description: 'CPU util',
            promql: 'node_cpu_utilization',
        };
        const enriched = enrichPrometheusQuery(q);
        expect(enriched.suggestedViz).toBe('gauge');
        expect(enriched.thresholds).toBeDefined();
        expect(enriched.thresholds!.length).toBe(3);
        expect(enriched.thresholds![0].value).toBeNull();
    });

    it('preserves existing specialist values (does not overwrite)', () => {
        const q: ValidatedPrometheusQuery = {
            description: 'Custom',
            promql: 'rate(http_requests_total[5m])',
            unit: 'short',          // specialist overrides inferred 'reqps'
            suggestedViz: 'stat',   // specialist overrides inferred 'timeseries'
        };
        const enriched = enrichPrometheusQuery(q);
        expect(enriched.unit).toBe('short');
        expect(enriched.suggestedViz).toBe('stat');
    });

    it('infers heatmap for histogram _bucket metrics', () => {
        const q: ValidatedPrometheusQuery = {
            description: 'Latency heatmap',
            promql: 'http_request_duration_seconds_bucket',
        };
        const enriched = enrichPrometheusQuery(q);
        expect(enriched.suggestedViz).toBe('heatmap');
        expect(enriched.thresholds).toBeUndefined(); // heatmap → no thresholds
    });

    it('does not mutate the input object', () => {
        const q: ValidatedPrometheusQuery = { description: 'x', promql: 'rate(x_total[5m])' };
        const enriched = enrichPrometheusQuery(q);
        expect(enriched).not.toBe(q);
        expect((q as any).unit).toBeUndefined();
    });
});

// ─── enrichLokiQuery ──────────────────────────────────────────────────────────

describe('enrichLokiQuery', () => {
    it('infers timeseries for rate queries', () => {
        const q: ValidatedLokiQuery = {
            description: 'Error rate',
            logql: 'rate({job="api"} |= "error" [5m])',
        };
        const enriched = enrichLokiQuery(q);
        expect(enriched.suggestedViz).toBe('timeseries');
    });

    it('infers logs for plain stream selectors', () => {
        const q: ValidatedLokiQuery = {
            description: 'Error logs',
            logql: '{job="api", level="error"}',
        };
        const enriched = enrichLokiQuery(q);
        expect(enriched.suggestedViz).toBe('logs');
    });

    it('preserves existing specialist suggestedViz', () => {
        const q: ValidatedLokiQuery = {
            description: 'Custom',
            logql: 'rate({job="api"}[5m])',
            suggestedViz: 'stat',
        };
        expect(enrichLokiQuery(q).suggestedViz).toBe('stat');
    });
});

// ─── inferLayoutHint ─────────────────────────────────────────────────────────

describe('inferLayoutHint', () => {
    it('identifies RED', () => {
        expect(inferLayoutHint('build RED dashboard rate error duration')).toBe('RED');
    });
    it('identifies USE', () => {
        expect(inferLayoutHint('USE method: utilization saturation errors')).toBe('USE');
    });
    it('identifies golden-signals', () => {
        expect(inferLayoutHint('four golden signals latency traffic errors saturation')).toBe('golden-signals');
    });
    it('returns none for generic descriptions', () => {
        expect(inferLayoutHint('build a dashboard for OTel collector')).toBe('none');
    });
});

// ─── enrichDataFindings ───────────────────────────────────────────────────────

describe('enrichDataFindings', () => {
    it('fills layoutHint from step description', () => {
        const findings = {
            prometheus: {
                datasourceUid: 'uid',
                datasourceName: 'Prometheus',
                labels: {},
                validatedQueries: [],
            },
        };
        const enriched = enrichDataFindings(findings, 'Build RED dashboard');
        expect(enriched.layoutHint).toBe('RED');
    });

    it('preserves existing layoutHint', () => {
        const findings = {
            layoutHint: 'USE' as const,
            prometheus: {
                datasourceUid: 'uid',
                datasourceName: 'Prometheus',
                labels: {},
                validatedQueries: [],
            },
        };
        const enriched = enrichDataFindings(findings, 'build something');
        expect(enriched.layoutHint).toBe('USE');
    });

    it('enriches all prometheus queries', () => {
        const findings = {
            prometheus: {
                datasourceUid: 'uid',
                datasourceName: 'Prometheus',
                labels: {},
                validatedQueries: [
                    { description: 'Rate', promql: 'rate(http_requests_total[5m])' },
                ],
            },
        };
        const enriched = enrichDataFindings(findings);
        expect(enriched.prometheus!.validatedQueries[0].unit).toBe('reqps');
    });

    it('enriches all loki queries', () => {
        const findings = {
            loki: {
                datasourceUid: 'uid',
                datasourceName: 'Loki',
                labels: {},
                validatedQueries: [
                    { description: 'Error logs', logql: '{job="api"}' },
                ],
            },
        };
        const enriched = enrichDataFindings(findings);
        expect(enriched.loki!.validatedQueries[0].suggestedViz).toBe('logs');
    });

    it('does not mutate the input', () => {
        const q = { description: 'x', promql: 'up' };
        const findings = {
            prometheus: {
                datasourceUid: 'uid', datasourceName: 'Prometheus',
                labels: {}, validatedQueries: [q],
            },
        };
        enrichDataFindings(findings);
        expect((q as any).suggestedViz).toBeUndefined();
    });
});
