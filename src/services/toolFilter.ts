import type { ToolsConfig } from '../types/settings.types';

/**
 * Canonical mapping of category name → tool names.
 * This is the single source of truth used by both the filter logic
 * and the config page UI. Names must match what grafana-llm-app's
 * MCP server exposes via tools/list.
 */
export const TOOL_CATEGORIES: Record<keyof ToolsConfig, string[]> = {
    loki: [
        'query_loki_logs',
        'query_loki_patterns',
        'query_loki_stats',
        'list_loki_label_names',
        'list_loki_label_values',
    ],
    prometheus: [
        'query_prometheus',
        'query_prometheus_histogram',
        'list_prometheus_label_names',
        'list_prometheus_label_values',
        'list_prometheus_metric_names',
        'list_prometheus_metric_metadata',
    ],
    dashboards: [
        'get_dashboard_by_uid',
        'get_dashboard_summary',
        'get_dashboard_panel_queries',
        'get_dashboard_property',
        'update_dashboard',
        'search_dashboards',
        'search_folders',
        'create_folder',
    ],
    datasources: [
        'list_datasources',
        'get_datasource_by_name',
        'get_datasource_by_uid',
    ],
};

// Note: TOOL_TO_CATEGORY reverse lookup removed — filterTools now scans all
// config keys directly, supporting both fixed and dynamic discovered categories.

/**
 * Returns a default ToolsConfig with all categories and tools enabled.
 * Used to initialise the config page for fresh installs.
 */
export function getDefaultToolsConfig(): ToolsConfig {
    const config = {} as ToolsConfig;
    for (const [category, tools] of Object.entries(TOOL_CATEGORIES) as [keyof ToolsConfig, string[]][]) {
        config[category] = {
            enabled: true,
            tools: Object.fromEntries(tools.map(t => [t, true])),
        };
    }
    return config;
}

/**
 * Filters an OpenAI-format tool list based on the user's ToolsConfig.
 *
 * Scans ALL keys in config (both the 4 fixed categories and any dynamic
 * discovered categories such as 'alerting', 'cloudwatch', 'oncall').
 *
 * - If config is undefined, all tools pass through (safe default for fresh installs).
 * - A tool is excluded only if it is explicitly present in a category's tools map
 *   AND that category is disabled, OR the tool's per-tool flag is false.
 * - Tools not found in any category pass through by default.
 */
export function filterTools(tools: any[], config?: ToolsConfig): any[] {
    if (!config) {
        return tools;
    }

    return tools.filter(t => {
        const name: string = t.function?.name;
        if (!name) {
            return false;
        }

        // Search all config keys (fixed + dynamic) for this tool name
        for (const catConfig of Object.values(config)) {
            if (!Object.prototype.hasOwnProperty.call(catConfig.tools, name)) {
                continue;
            }
            // Tool found in this category
            if (!catConfig.enabled) {
                return false;
            }
            return catConfig.tools[name] === true;
        }

        // Tool not found in any configured category — pass through
        return true;
    });
}
