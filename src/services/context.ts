import { getBackendSrv, getTemplateSrv, getDataSourceSrv } from '@grafana/runtime';

// Import types from centralized location
import type {
    DashboardContext, UserContext, DataSourceContext,
    DashboardSchemaCapability, GrafanaBuildInfo,
} from '../types/context.types';

// Re-export for backward compatibility
export type { DashboardContext, UserContext, DataSourceContext, DashboardSchemaCapability, GrafanaBuildInfo };

export const contextService = {
    getDashboardUid(): string | null {
        const path = window.location.pathname;
        // URL format: /d/<uid>/<slug>
        const match = path.match(/\/d\/([^/]+)/);
        return match ? match[1] : null;
    },

    getUserContext(): UserContext {
        const user = (window as any).grafanaBootData?.user ?? {};
        return {
            name: user.name,
            email: user.email,
            login: user.login,
            orgId: user.orgId,
            orgName: user.orgName,
            orgRole: user.orgRole,
        };
    },

    getDataSources(): DataSourceContext[] {
        return getDataSourceSrv().getList().map((ds) => ({
            name: ds.name,
            type: ds.type,
            uid: ds.uid,
        }));
    },

    /**
     * Returns the running Grafana version and derived dashboard schema capability.
     * Reads synchronously from the Grafana boot config — no network call required.
     *
     * Schema capability heuristic:
     *   major ≥ 12 → 'v2-capable' (app-platform / dashboard.grafana.app API may be available)
     *   otherwise  → 'v1' (Classic panels[]/templating.list only)
     *
     * This is a NECESSARY but not SUFFICIENT condition for V2 writes — the MCP server
     * must also support it (mcp-grafana ≥ v0.16.0). The dashboard agent performs an
     * authoritative runtime probe via get_dashboard_by_uid after creating the skeleton.
     */
    getBuildInfo(): GrafanaBuildInfo {
        const version = (window as any).grafanaBootData?.settings?.buildInfo?.version ?? '0.0.0';
        const major = parseInt(version.split('.')[0] ?? '0', 10);
        const dashboardSchema: DashboardSchemaCapability = major >= 12 ? 'v2-capable' : 'v1';
        return { version, dashboardSchema };
    },

    async getCurrentDashboard(): Promise<DashboardContext> {
        const uid = this.getDashboardUid();
        if (!uid) {
            return {};
        }

        try {
            const dashboard = await getBackendSrv().get(`/api/dashboards/uid/${uid}`);

            const variables: Record<string, string> = {};
            getTemplateSrv().getVariables().forEach((v: any) => {
                variables[v.name] = getTemplateSrv().replace(`$${v.name}`);
            });

            return {
                uid,
                title: dashboard.dashboard.title,
                json: dashboard.dashboard,
                variables,
            };
        } catch (error) {
            console.error('Failed to fetch dashboard context:', error);
            return { uid };
        }
    },
};
