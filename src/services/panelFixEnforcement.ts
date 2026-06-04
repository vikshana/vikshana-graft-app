import { enforceScopedPanelUpdateArgs } from './panelFixScope';
import {
    getPanelFixBaseline,
    getPanelFixScope,
    setPanelFixRevertedCount,
} from './panelFixSessionStorage';
import { coerceScopedPanelFixUpdateArgs, normalizeUpdateDashboardArgs } from './updateDashboardArgs';

/** Normalize and scope-limit update_dashboard args before MCP (kept out of session storage to avoid import cycles). */
export function applyPanelFixScopeEnforcement(args: Record<string, unknown>): Record<string, unknown> {
    const scope = getPanelFixScope();
    const baseline = getPanelFixBaseline();
    let normalized = normalizeUpdateDashboardArgs(args);
    if (!scope || !baseline) {
        return normalized;
    }
    normalized = coerceScopedPanelFixUpdateArgs(normalized, baseline, scope);
    const result = enforceScopedPanelUpdateArgs(normalized, scope, baseline);
    if (result.panelsReverted > 0) {
        setPanelFixRevertedCount(result.panelsReverted);
    }
    return result.args;
}
