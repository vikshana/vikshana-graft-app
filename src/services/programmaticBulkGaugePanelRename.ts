import type { ToolExecution } from '../types/llm.types';
import { extractDashboardFromGetByUid } from './programmaticDashboardClone';
import { callMcpTool } from './mcpToolClient';
import type { McpClient } from './dashboardChunkedUpdate';
import { stampDashboardForOverwrite } from './fluxQueryFix';
import { normalizeUpdateDashboardArgs } from './updateDashboardArgs';
import { getPanelAtPath, listDashboardPanels } from './panelDiscovery';
import { resolveDashboardUid } from './programmaticDashboardResolve';
import type { BulkGaugePanelRenameRequest } from './bulkGaugePanelRenameParse';

type PanelRecord = Record<string, unknown>;

export interface BulkGaugePanelRenameResult {
    ok: boolean;
    error?: string;
    toolExecutions: ToolExecution[];
    dashboardUid?: string;
    dashboardTitle?: string;
    version?: number;
    titlePrefix?: string;
    renamedPanels?: Array<{ from: string; to: string; panelId?: number }>;
    skippedPanels?: string[];
}

function pendingTool(name: string): ToolExecution {
    return { name, status: 'pending' };
}

function finishTool(step: ToolExecution, outcome: { ok: boolean; error?: string; summary?: string }): ToolExecution {
    return { ...step, status: outcome.ok ? 'success' : 'error', error: outcome.error, summary: outcome.summary };
}

function applyTitlePrefix(currentTitle: string, prefix: string): string {
    const trimmedPrefix = prefix.trim();
    const trimmedTitle = currentTitle.trim();
    if (!trimmedPrefix) {
        return trimmedTitle;
    }
    if (trimmedTitle.toLowerCase().startsWith(trimmedPrefix.toLowerCase())) {
        return trimmedTitle;
    }
    return `${trimmedPrefix} ${trimmedTitle}`;
}

export async function runProgrammaticBulkGaugePanelRename(
    mcpClient: McpClient,
    request: BulkGaugePanelRenameRequest,
    opts?: { contextDashboardUid?: string }
): Promise<BulkGaugePanelRenameResult> {
    const toolExecutions: ToolExecution[] = [];
    const resolved = await resolveDashboardUid(
        mcpClient,
        {
            dashboardUid: request.dashboardUid ?? opts?.contextDashboardUid,
            machineId: request.machineId,
        },
        toolExecutions
    );
    if (!resolved.uid) {
        return { ok: false, error: resolved.error ?? 'Could not resolve dashboard uid.', toolExecutions };
    }

    const getStep = pendingTool('get_dashboard_by_uid');
    toolExecutions.push(getStep);
    const fetch = await callMcpTool(mcpClient, 'get_dashboard_by_uid', { uid: resolved.uid });
    toolExecutions[toolExecutions.length - 1] = finishTool(getStep, fetch);
    if (!fetch.ok) {
        return { ok: false, error: fetch.error ?? 'Could not load dashboard', toolExecutions, dashboardUid: resolved.uid };
    }

    const extracted = extractDashboardFromGetByUid(fetch.text);
    if (!extracted?.dashboard) {
        return { ok: false, error: 'Could not parse dashboard JSON', toolExecutions, dashboardUid: resolved.uid };
    }

    const baseline = extracted.dashboard as Record<string, unknown>;
    const dashboardTitle = typeof baseline.title === 'string' ? baseline.title : resolved.title;
    const entries = listDashboardPanels(baseline.panels);
    const gaugeEntries = entries.filter((e) => String(e.panel.type ?? '').toLowerCase() === 'gauge' && e.title.trim());

    if (gaugeEntries.length === 0) {
        return {
            ok: false,
            error: 'No gauge panels found on this dashboard.',
            toolExecutions,
            dashboardUid: resolved.uid,
            dashboardTitle,
            titlePrefix: request.titlePrefix,
        };
    }

    const proposed = JSON.parse(JSON.stringify(baseline)) as Record<string, unknown>;
    const rootPanels = Array.isArray(proposed.panels) ? (proposed.panels as PanelRecord[]) : [];
    const renamedPanels: Array<{ from: string; to: string; panelId?: number }> = [];
    const skippedPanels: string[] = [];

    for (const entry of gaugeEntries) {
        const newTitle = applyTitlePrefix(entry.title, request.titlePrefix);
        if (newTitle === entry.title.trim()) {
            skippedPanels.push(entry.title);
            continue;
        }
        const panel = getPanelAtPath(rootPanels, entry.path);
        if (!panel) {
            continue;
        }
        panel.title = newTitle;
        renamedPanels.push({
            from: entry.title,
            to: newTitle,
            panelId: entry.panelId,
        });
    }

    if (renamedPanels.length === 0) {
        return {
            ok: false,
            error: `All ${gaugeEntries.length} gauge panel(s) already begin with **${request.titlePrefix}**.`,
            toolExecutions,
            dashboardUid: resolved.uid,
            dashboardTitle,
            titlePrefix: request.titlePrefix,
            skippedPanels,
        };
    }

    proposed.panels = rootPanels;

    const saveStep = pendingTool('update_dashboard');
    toolExecutions.push(saveStep);
    const savePayload = normalizeUpdateDashboardArgs({
        dashboard: stampDashboardForOverwrite(baseline, proposed),
        overwrite: true,
        message: `Graft: prefix gauge panels with "${request.titlePrefix}"`,
    });
    const saveResult = await callMcpTool(mcpClient, 'update_dashboard', savePayload);
    toolExecutions[toolExecutions.length - 1] = finishTool(saveStep, saveResult);
    if (!saveResult.ok) {
        return {
            ok: false,
            error: saveResult.error ?? 'update_dashboard failed',
            toolExecutions,
            dashboardUid: resolved.uid,
            dashboardTitle,
            titlePrefix: request.titlePrefix,
            renamedPanels,
            skippedPanels,
        };
    }

    const verifyStep = pendingTool('get_dashboard_by_uid');
    toolExecutions.push(verifyStep);
    const verify = await callMcpTool(mcpClient, 'get_dashboard_by_uid', { uid: resolved.uid });
    toolExecutions[toolExecutions.length - 1] = finishTool(verifyStep, verify);
    if (!verify.ok) {
        return {
            ok: false,
            error: 'Save reported success but dashboard could not be re-fetched for verification.',
            toolExecutions,
            dashboardUid: resolved.uid,
            dashboardTitle,
            titlePrefix: request.titlePrefix,
            renamedPanels,
            skippedPanels,
        };
    }

    const verified = extractDashboardFromGetByUid(verify.text);
    const version = typeof verified?.dashboard?.version === 'number' ? verified.dashboard.version : undefined;
    const verifiedEntries = listDashboardPanels(verified?.dashboard?.panels);
    const missing = renamedPanels.filter(
        (r) => !verifiedEntries.some((e) => e.title.trim() === r.to)
    );
    if (missing.length > 0) {
        return {
            ok: false,
            error: `Save reported success but ${missing.length} renamed panel(s) were not found after verification.`,
            toolExecutions,
            dashboardUid: resolved.uid,
            dashboardTitle,
            version,
            titlePrefix: request.titlePrefix,
            renamedPanels,
            skippedPanels,
        };
    }

    return {
        ok: true,
        toolExecutions,
        dashboardUid: resolved.uid,
        dashboardTitle,
        version,
        titlePrefix: request.titlePrefix,
        renamedPanels,
        skippedPanels: skippedPanels.length > 0 ? skippedPanels : undefined,
    };
}

export function formatBulkGaugePanelRenameReply(result: BulkGaugePanelRenameResult, buildNumber: number): string {
    if (result.ok) {
        const lines = (result.renamedPanels ?? [])
            .map((r) => `- **${r.from}** → **${r.to}**` + (r.panelId != null ? ` (id ${r.panelId})` : ''))
            .join('\n');
        const skipped =
            result.skippedPanels && result.skippedPanels.length > 0
                ? `\n\n**Skipped** (already prefixed): ${result.skippedPanels.join(', ')}`
                : '';
        return (
            `### Gauge panels renamed (Graft build ${buildNumber})\n\n` +
            `Prefixed **${result.renamedPanels?.length ?? 0}** gauge panel(s) with **${result.titlePrefix ?? '?'}**:\n` +
            lines +
            `\n- **Dashboard:** ${result.dashboardTitle ?? '(untitled)'} — uid \`${result.dashboardUid ?? '?'}\`` +
            (result.version != null ? `\n- **Version:** ${result.version}` : '') +
            skipped +
            `\n\nHard-refresh the dashboard (**Cmd+Shift+R**) to see updated titles.`
        );
    }
    return `### Could not rename gauge panels\n\n${result.error ?? 'Unknown error.'}`;
}
