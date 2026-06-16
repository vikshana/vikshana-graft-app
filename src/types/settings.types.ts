import type { CategoryDef } from './prompt.types';

/**
 * Configuration for a single tool category (e.g. Loki, Prometheus).
 * Controls whether the category as a whole is enabled, and fine-grained
 * per-tool toggles within it.
 */
export interface ToolCategoryConfig {
    enabled: boolean;
    /** Map of tool name → enabled. Only tools present here are explicitly controlled. */
    tools: Record<string, boolean>;
}

/**
 * Top-level tool access configuration, persisted in plugin jsonData.
 * Each key corresponds to one of the known MCP tool categories.
 */
export interface ToolsConfig {
    loki: ToolCategoryConfig;
    prometheus: ToolCategoryConfig;
    dashboards: ToolCategoryConfig;
    datasources: ToolCategoryConfig;
}

/**
 * Shape of the plugin's jsonData stored in Grafana.
 * Extended to include tool access config and agent behaviour settings.
 */
export interface AppPluginSettings {
    promptLibrary?: CategoryDef[];
    tools?: ToolsConfig;
    /** Maximum number of tool call iterations per agent step. Default: 10. */
    maxToolIterations?: number;
}
