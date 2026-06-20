/**
 * Deterministic dashboard enrichment layer.
 *
 * Fills presentation metadata gaps that the specialist LLM may have left empty.
 * Applied by the dashboard agent before building panel JSON, so panel quality
 * does not depend solely on model compliance.
 *
 * Strategy mirrors the existing datasource self-audit pattern: prompt first,
 * code-side safety net second.
 */

import type {
    ValidatedLokiQuery,
    ValidatedPrometheusQuery,
    PanelUnit,
    MetricType,
    SuggestedViz,
    PanelThreshold,
    DataFindings,
    LayoutHint,
} from '../agents/types';

// ─── Unit inference ───────────────────────────────────────────────────────────

/**
 * Infer the Grafana fieldConfig unit from a PromQL expression or metric name.
 * Returns undefined if no pattern matches (keeps the specialist's value or leaves blank).
 */
export function inferUnit(promql: string): PanelUnit | undefined {
    const expr = promql.toLowerCase();

    // Duration / latency
    if (/_seconds\b/.test(expr) || /_duration_seconds/.test(expr) || /latency_seconds/.test(expr)) {
        return 's';
    }
    if (/_milliseconds\b/.test(expr) || /_duration_ms\b/.test(expr) || /latency_ms\b/.test(expr)) {
        return 'ms';
    }
    if (/_nanoseconds\b/.test(expr)) { return 'ns'; }

    // Data size / throughput
    if (/_bytes\b/.test(expr)) { return 'bytes'; }
    if (/_bytes_per_second\b/.test(expr) || /throughput_bytes/.test(expr)) { return 'Bps'; }

    // Ratios / percentages
    if (/_ratio\b/.test(expr) || /_utilization\b/.test(expr) || /ratio\b.*rate\b/.test(expr)) {
        // Distinguish 0-1 ratios from 0-100 percent
        return 'percentunit';
    }
    if (/_percent\b/.test(expr) || /_percentage\b/.test(expr)) { return 'percent'; }

    // Request / event rates — rate() applied to _total counters
    if (/rate\s*\(/.test(expr) && (/_total\b/.test(expr) || /_count\b/.test(expr))) {
        return 'reqps';
    }

    // Write / read rates
    if (/rate\s*\(.*_writes/.test(expr) || /rate\s*\(.*_written/.test(expr)) { return 'wps'; }
    if (/rate\s*\(.*_reads/.test(expr) || /rate\s*\(.*_read/.test(expr)) { return 'rps'; }

    return undefined;
}

// ─── Metric type inference ────────────────────────────────────────────────────

/**
 * Infer the Prometheus metric type from the metric name in a PromQL expression.
 */
export function inferMetricType(promql: string): MetricType | undefined {
    const expr = promql.toLowerCase();
    if (/_bucket\b/.test(expr)) { return 'histogram'; }
    if (/_sum\b/.test(expr) || /_count\b/.test(expr) || /_total\b/.test(expr)) { return 'counter'; }
    if (/_quantile\b/.test(expr) || /histogram_quantile\s*\(/.test(expr)) { return 'summary'; }
    // Anything with rate() on a counter — treat as counter
    if (/rate\s*\(/.test(expr)) { return 'counter'; }
    return undefined;
}

// ─── Visualization inference ──────────────────────────────────────────────────

/**
 * Infer the best Grafana visualization type for a PromQL expression.
 * Returns undefined if the specialist's choice should be kept.
 */
export function inferVizPrometheus(promql: string, metricType?: MetricType): SuggestedViz | undefined {
    const expr = promql.toLowerCase();
    const mt = metricType ?? inferMetricType(expr);

    // Histograms → heatmap (when using _bucket), otherwise quantile → timeseries
    if (mt === 'histogram' && /_bucket\b/.test(expr)) { return 'heatmap'; }
    if (/histogram_quantile\s*\(/.test(expr)) { return 'timeseries'; }

    // Ratio/utilization that fits 0-1 or 0-100 → gauge
    if (/_ratio\b/.test(expr) || /_utilization\b/.test(expr) || /_percentage\b/.test(expr)) {
        return 'gauge';
    }

    // Single scalar up/info metrics → stat
    if (/\bup\b/.test(expr) || /_info\b/.test(expr) || /_version\b/.test(expr) ||
        /_uptime_seconds\b/.test(expr)) {
        return 'stat';
    }

    // Rate queries → timeseries by default
    if (/rate\s*\(/.test(expr)) { return 'timeseries'; }

    return undefined;
}

/**
 * Infer the best Grafana visualization type for a LogQL expression.
 */
export function inferVizLoki(logql: string): SuggestedViz | undefined {
    const expr = logql.toLowerCase();
    // Metric queries (sum/count/rate over log range) → timeseries or stat
    if (/\|\s*unwrap\b/.test(expr) || /rate\s*\(/.test(expr) || /count_over_time\s*\(/.test(expr) ||
        /sum\s*\(/.test(expr) || /avg_over_time\s*\(/.test(expr)) {
        return 'timeseries';
    }
    // Plain log stream selectors → logs panel
    return 'logs';
}

// ─── Default thresholds ───────────────────────────────────────────────────────

/** Default thresholds for stat/gauge/bargauge panels (green → orange → red) */
export const DEFAULT_THRESHOLDS: PanelThreshold[] = [
    { value: null, color: 'green' },
    { value: 80,   color: 'orange' },
    { value: 90,   color: 'red' },
];

/** Error-rate thresholds (0–1 ratio) */
export const ERROR_RATE_THRESHOLDS: PanelThreshold[] = [
    { value: null,  color: 'green' },
    { value: 0.01,  color: 'orange' },
    { value: 0.05,  color: 'red' },
];

/** Percentunit (0–1) utilization thresholds */
export const UTILIZATION_THRESHOLDS: PanelThreshold[] = [
    { value: null, color: 'green' },
    { value: 0.75, color: 'orange' },
    { value: 0.90, color: 'red' },
];

/**
 * Pick default thresholds appropriate for a query based on its unit and metric context.
 */
export function defaultThresholdsFor(unit: PanelUnit | undefined, promql: string): PanelThreshold[] {
    const expr = promql.toLowerCase();
    if (unit === 'percentunit' || /_ratio\b/.test(expr) || /_utilization\b/.test(expr)) {
        return UTILIZATION_THRESHOLDS;
    }
    if (/_error/.test(expr) || /error_rate/.test(expr)) {
        return ERROR_RATE_THRESHOLDS;
    }
    return DEFAULT_THRESHOLDS;
}

// ─── Per-query enrichment ─────────────────────────────────────────────────────

/**
 * Fills missing presentation metadata on a single Prometheus query using
 * deterministic pattern matching. Existing specialist values are preserved.
 */
export function enrichPrometheusQuery(q: ValidatedPrometheusQuery): ValidatedPrometheusQuery {
    const unit = q.unit ?? inferUnit(q.promql);
    const metricType = q.metricType ?? inferMetricType(q.promql);
    const suggestedViz = q.suggestedViz ?? inferVizPrometheus(q.promql, metricType);

    // Only add thresholds for non-timeseries, non-heatmap panels
    const needsThresholds = suggestedViz && !['timeseries', 'heatmap', 'table', 'logs'].includes(suggestedViz);
    const thresholds = q.thresholds ?? (needsThresholds ? defaultThresholdsFor(unit, q.promql) : undefined);

    return {
        ...q,
        ...(unit !== undefined ? { unit } : {}),
        ...(metricType !== undefined ? { metricType } : {}),
        ...(suggestedViz !== undefined ? { suggestedViz } : {}),
        ...(thresholds !== undefined ? { thresholds } : {}),
    };
}

/**
 * Fills missing presentation metadata on a single Loki query.
 */
export function enrichLokiQuery(q: ValidatedLokiQuery): ValidatedLokiQuery {
    const suggestedViz = q.suggestedViz ?? inferVizLoki(q.logql);
    return {
        ...q,
        ...(suggestedViz !== undefined ? { suggestedViz } : {}),
    };
}

// ─── DataFindings enrichment ──────────────────────────────────────────────────

/**
 * Infer a layout hint from the step description and/or user message.
 * Drives row grouping (v1) and tab layout (v2).
 */
export function inferLayoutHint(text: string): LayoutHint {
    const t = text.toLowerCase();
    if (/\bred\b/.test(t) || /rate.*error.*duration/.test(t) || /error.*duration/.test(t)) { return 'RED'; }
    if (/\buse\b/.test(t) || /utiliz.*saturat/.test(t)) { return 'USE'; }
    if (/golden.?signal/.test(t) || /latency.*traffic.*error.*saturat/.test(t)) { return 'golden-signals'; }
    return 'none';
}

/**
 * Applies enrichment to all queries in a DataFindings object and fills any
 * missing layoutHint. Returns a new object — does not mutate input.
 */
export function enrichDataFindings(
    findings: DataFindings,
    stepDescription?: string,
    userMessage?: string,
): DataFindings {
    const hint = findings.layoutHint ??
        inferLayoutHint([stepDescription ?? '', userMessage ?? ''].join(' '));

    return {
        ...findings,
        layoutHint: hint,
        ...(findings.prometheus ? {
            prometheus: {
                ...findings.prometheus,
                validatedQueries: findings.prometheus.validatedQueries.map(enrichPrometheusQuery),
            },
        } : {}),
        ...(findings.loki ? {
            loki: {
                ...findings.loki,
                validatedQueries: findings.loki.validatedQueries.map(enrichLokiQuery),
            },
        } : {}),
    };
}
