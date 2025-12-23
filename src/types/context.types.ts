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
