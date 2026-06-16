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

// Reverse lookup: tool name → category key
const TOOL_TO_CATEGORY: Record<string, keyof ToolsConfig> = {};
for (const [category, tools] of Object.entries(TOOL_CATEGORIES) as [keyof ToolsConfig, string[]][]) {
    for (const tool of tools) {
        TOOL_TO_CATEGORY[tool] = category;
    }
}

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
 * - If config is undefined, all tools pass through (safe default for fresh installs).
 * - Tools not in TOOL_CATEGORIES (i.e. newly discovered from the MCP server) pass
 *   through by default unless explicitly present and disabled in config.
 * - Tools in a disabled category are always excluded regardless of per-tool setting.
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

        const category = TOOL_TO_CATEGORY[name];

        // Tool is not in any known category — pass through by default
        if (!category) {
            return true;
        }

        const categoryConfig = config[category];

        // Category is disabled — exclude all its tools
        if (!categoryConfig?.enabled) {
            return false;
        }

        // Per-tool check: if explicitly set to false, exclude; otherwise include
        if (Object.prototype.hasOwnProperty.call(categoryConfig.tools, name)) {
            return categoryConfig.tools[name] === true;
        }

        // Tool not in config map but category is enabled — include by default
        return true;
    });
}
