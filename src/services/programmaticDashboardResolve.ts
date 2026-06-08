import type { ToolExecution } from '../types/llm.types';
import { callMcpTool } from './mcpToolClient';
import type { McpClient } from './dashboardChunkedUpdate';
import { parseSearchHitsFromMcpText } from './dashboardSearchParse';
import { MACHINE_ID_PATTERN } from './dashboardCloneParse';

export interface DashboardResolveRequest {
    dashboardUid?: string;
    dashboardTitle?: string;
    titleLabel?: string;
    machineId?: string;
}

/** Well-known instrumentation dashboards (label → uid). */
export const KNOWN_INSTRUMENTATION_DASHBOARD_UIDS: Record<string, string> = {
    keysight: 'cfo0wckufbdhce',
};

export function inferMachineIdFromDashboardTitle(title: string | undefined): string | undefined {
    if (!title) {
        return undefined;
    }
    const m = title.match(MACHINE_ID_PATTERN);
    return m?.[0];
}

function pendingTool(name: string): ToolExecution {
    return { name, status: 'pending' };
}

function finishTool(step: ToolExecution, outcome: { ok: boolean; error?: string; summary?: string }): ToolExecution {
    return { ...step, status: outcome.ok ? 'success' : 'error', error: outcome.error, summary: outcome.summary };
}

export async function resolveDashboardUid(
    mcpClient: McpClient,
    request: DashboardResolveRequest,
    toolExecutions: ToolExecution[]
): Promise<{ uid?: string; title?: string; error?: string }> {
    if (request.dashboardUid) {
        return { uid: request.dashboardUid };
    }

    const labelKey = request.titleLabel?.trim().toLowerCase();
    if (labelKey && KNOWN_INSTRUMENTATION_DASHBOARD_UIDS[labelKey]) {
        return { uid: KNOWN_INSTRUMENTATION_DASHBOARD_UIDS[labelKey] };
    }

    const searchQuery =
        request.dashboardTitle ??
        request.machineId ??
        (request.titleLabel ? `${request.titleLabel}` : undefined);
    if (!searchQuery) {
        return { error: 'Need dashboard uid, title, or machine id.' };
    }

    const searchStep = pendingTool('search_dashboards');
    toolExecutions.push(searchStep);
    const searchResult = await callMcpTool(mcpClient, 'search_dashboards', { query: searchQuery });
    toolExecutions[toolExecutions.length - 1] = finishTool(searchStep, searchResult);
    if (!searchResult.ok) {
        return { error: searchResult.error ?? 'Dashboard search failed' };
    }

    const hits = parseSearchHitsFromMcpText(searchResult.text);
    const machine = request.machineId ?? inferMachineIdFromDashboardTitle(request.dashboardTitle);
    const match =
        hits.find((h) => request.dashboardTitle && h.title?.includes(request.dashboardTitle)) ??
        hits.find((h) => machine && h.title?.includes(machine)) ??
        hits.find((h) => request.titleLabel && h.title?.toLowerCase().includes(request.titleLabel.toLowerCase())) ??
        hits[0];
    if (!match?.uid) {
        return { error: `No dashboard found for "${searchQuery}".` };
    }
    return { uid: match.uid, title: match.title };
}
