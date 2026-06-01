import { getBackendSrv, getTemplateSrv, config, getDataSourceSrv } from '@grafana/runtime';

// Import types from centralized location
import type { DashboardContext, UserContext, DataSourceContext } from '../types/context.types';

// Re-export for backward compatibility
export type { DashboardContext, UserContext, DataSourceContext };

const LAST_DASHBOARD_UID_KEY = 'graft_last_dashboard_uid';

export const contextService = {
    getDashboardUid(): string | null {
        const path = window.location.pathname;
        // URL format: /d/<uid>/<slug>
        const match = path.match(/\/d\/([^/]+)/);
        if (match) {
            try {
                sessionStorage.setItem(LAST_DASHBOARD_UID_KEY, match[1]);
            } catch {
                // ignore storage errors
            }
            return match[1];
        }

        try {
            return sessionStorage.getItem(LAST_DASHBOARD_UID_KEY);
        } catch {
            return null;
        }
    },

    getUserContext(): UserContext {
        const user = config.bootData.user;
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
