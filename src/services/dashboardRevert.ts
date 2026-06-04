import type { ToolExecution } from '../types/llm.types';
import { extractDashboardFromGetByUid } from './programmaticDashboardClone';
import {
    clearDashboardRevertSnapshot,
    getDashboardRevertSnapshot,
    type DashboardRevertSnapshot,
} from './dashboardRevertStorage';
import { callMcpTool, parseJsonFromMcpText } from './mcpToolClient';

export type McpClient = {
    callTool: (req: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>;
};

export interface RevertDashboardResult {
    ok: boolean;
    error?: string;
    uid?: string;
    version?: number;
    toolExecutions: ToolExecution[];
}

function pendingTool(name: string): ToolExecution {
    return { name, status: 'pending' };
}

function finishTool(step: ToolExecution, outcome: { ok: boolean; error?: string; summary?: string }): ToolExecution {
    return {
        ...step,
        status: outcome.ok ? 'success' : 'error',
        error: outcome.error,
        summary: outcome.summary,
    };
}

/** Restore dashboard to JSON captured before Graft's last save on this uid. */
export async function revertLastDashboardChange(mcpClient: McpClient): Promise<RevertDashboardResult> {
    const snapshot = getDashboardRevertSnapshot();
    if (!snapshot) {
        return {
            ok: false,
            error: 'No dashboard snapshot to revert. Run a panel fix or edit first (Graft saves a snapshot from get_dashboard_by_uid before update).',
            toolExecutions: [],
        };
    }

    return revertDashboardToSnapshot(mcpClient, snapshot);
}

export async function revertDashboardToSnapshot(
    mcpClient: McpClient,
    snapshot: DashboardRevertSnapshot
): Promise<RevertDashboardResult> {
    const toolExecutions: ToolExecution[] = [];

    const getStep = pendingTool('get_dashboard_by_uid');
    toolExecutions.push(getStep);
    const current = await callMcpTool(mcpClient, 'get_dashboard_by_uid', { uid: snapshot.uid });
    toolExecutions[toolExecutions.length - 1] = finishTool(current, current);

    if (!current.ok) {
        return { ok: false, error: current.error ?? 'Could not load current dashboard', toolExecutions };
    }

    const extracted = extractDashboardFromGetByUid(current.text);
    const currentVersion =
        extracted?.dashboard && typeof extracted.dashboard.version === 'number'
            ? extracted.dashboard.version
            : undefined;

    const restoreDashboard: Record<string, unknown> = {
        ...JSON.parse(JSON.stringify(snapshot.dashboard)),
        uid: snapshot.uid,
        version: currentVersion,
    };

    const saveStep = pendingTool('update_dashboard');
    toolExecutions.push(saveStep);
    const save = await callMcpTool(mcpClient, 'update_dashboard', {
        dashboard: restoreDashboard,
        overwrite: true,
        message: `Graft revert to snapshot from ${new Date(snapshot.capturedAt).toISOString()}`,
    });
    toolExecutions[toolExecutions.length - 1] = finishTool(save, save);

    if (!save.ok) {
        return { ok: false, error: save.error ?? 'Revert save failed', toolExecutions };
    }

    let version = currentVersion;
    const parsed = parseJsonFromMcpText(save.text);
    if (parsed && typeof parsed === 'object' && typeof (parsed as { version?: number }).version === 'number') {
        version = (parsed as { version: number }).version;
    }

    clearDashboardRevertSnapshot();

    return {
        ok: true,
        uid: snapshot.uid,
        version,
        toolExecutions,
    };
}

export function formatRevertSuccessMessage(uid: string, title?: string, version?: number): string {
    const label = title ? `**${title}**` : `uid \`${uid}\``;
    const ver = version != null ? ` (version ${version})` : '';
    const base =
        `### Reverted\n\n` +
        `Restored ${label} to the dashboard JSON from **before Graft's last save**${ver}.\n\n` +
        `**What to do:** Hard-refresh the dashboard page (**Cmd+Shift+R**).`;
    const tip =
        `\n\n---\n\n**Faster next time** — scoped panel fix:\n\n` +
        `\`Fix only panel id N on dashboard uid ${uid}. Do not change other panels.\``;
    return `${base}${tip}`;
}
