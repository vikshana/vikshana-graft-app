// Grafana context related type definitions

/**
 * Dashboard context information
 */
export interface DashboardContext {
    uid?: string;
    title?: string;
    json?: any;
    variables?: Record<string, string>;
}

/**
 * Current user context from Grafana
 */
export interface UserContext {
    name?: string;
    email?: string;
    login?: string;
    orgId?: number;
    orgName?: string;
    orgRole?: string;
}

/**
 * Data source context information
 */
export interface DataSourceContext {
    name: string;
    type: string;
    uid: string;
}

/**
 * Dashboard schema capability detected from the running Grafana version.
 *   'v1'         — Classic panels[]/templating.list (always supported)
 *   'v2-capable' — Grafana ≥ 12 with app-platform API; elements/layout may be used
 */
export type DashboardSchemaCapability = 'v1' | 'v2-capable';

/**
 * Grafana build information read from the runtime config.
 */
export interface GrafanaBuildInfo {
    /** Semver version string, e.g. "12.3.0" */
    version: string;
    /** Derived dashboard schema capability */
    dashboardSchema: DashboardSchemaCapability;
}

