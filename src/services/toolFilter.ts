/**
 * Allowlist of MCP tools relevant to Loki log querying, Prometheus metrics,
 * and dashboard building. All other tools (alerting, oncall, pyroscope,
 * clickhouse, cloudwatch, elasticsearch, annotations, admin, etc.) are excluded
 * to reduce input token usage per API call.
 */
const ALLOWED_TOOLS = new Set([
    // Loki
    'query_loki_logs',
    'query_loki_patterns',
    'query_loki_stats',
    'list_loki_label_names',
    'list_loki_label_values',
    // Prometheus
    'query_prometheus',
    'query_prometheus_histogram',
    'list_prometheus_label_names',
    'list_prometheus_label_values',
    'list_prometheus_metric_names',
    'list_prometheus_metric_metadata',
    // Dashboards
    'get_dashboard_by_uid',
    'get_dashboard_summary',
    'get_dashboard_panel_queries',
    'get_dashboard_property',
    'update_dashboard',
    'search_dashboards',
    'search_folders',
    'create_folder',
    // Datasources (required context for queries)
    'list_datasources',
    'get_datasource_by_name',
    'get_datasource_by_uid',
]);

const MUTATING_ONLY_TOOLS = new Set(['update_dashboard']);

/**
 * Filters MCP tools to only those in the allowed set.
 * Reduces tool token usage from ~14,800 to ~5,300 tokens per API call.
 */
export function filterTools(tools: any[]): any[] {
    return tools.filter((t) => ALLOWED_TOOLS.has(t.function?.name));
}

/** Remove update_dashboard for read-only LLM intents (review/suggest/investigate). */
export function filterToolsForReadOnlyIntent(tools: any[]): any[] {
    return filterTools(tools).filter((t) => !MUTATING_ONLY_TOOLS.has(t.function?.name ?? ''));
}
