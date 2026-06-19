import type { ToolExecution } from '../types/llm.types';
import { extractDashboardFromGetByUid } from './programmaticDashboardClone';
import { callMcpTool } from './mcpToolClient';
import type { McpClient } from './dashboardChunkedUpdate';
import { applyFluxFixesToPanel, stampDashboardForOverwrite } from './fluxQueryFix';
import {
    formatPanelTargetLabel,
    resolvePanelForScopedFix,
} from './panelDiscovery';
import {
    enforceScopedPanelDashboardMerge,
    replacePanelInDashboard,
    type ScopedPanelFixTarget,
} from './panelFixScope';
import { setPanelFixBaseline, setPanelFixResolvedPanel, setPanelFixScope } from './panelFixSessionStorage';
import { normalizeUpdateDashboardArgs } from './updateDashboardArgs';
import { formatPanelVerificationBlock, scanPanelFluxIssues } from './panelFluxVerification';
import { panelPeerBandTargetsStillStale } from './fluxPeerBandFix';

export interface ProgrammaticScopedPanelFixResult {
    ok: boolean;
    error?: string;
    warning?: string;
    resolvedTitle?: string;
    resolvedPanelId?: number;
    toolExecutions: ToolExecution[];
    targetsFixed?: number;
    verificationNote?: string;
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

/**
 * Load dashboard, fix known-bad Flux on one panel, save via MCP (no LLM).
 */
export async function runProgrammaticScopedPanelFix(
    mcpClient: McpClient,
    scope: ScopedPanelFixTarget,
    userMessage: string
): Promise<ProgrammaticScopedPanelFixResult> {
    if (!scope.dashboardUid) {
        return { ok: false, error: 'Scoped fix requires dashboard uid', toolExecutions: [] };
    }
    if (scope.panelId == null && scope.panelArrayIndex == null && !scope.panelTitle) {
        return { ok: false, error: 'Scoped fix requires panel id, index, or title', toolExecutions: [] };
    }

    const toolExecutions: ToolExecution[] = [];

    const getStep = pendingTool('get_dashboard_by_uid');
    toolExecutions.push(getStep);
    const getResult = await callMcpTool(mcpClient, 'get_dashboard_by_uid', { uid: scope.dashboardUid });
    toolExecutions[toolExecutions.length - 1] = finishTool(getStep, getResult);

    if (!getResult.ok) {
        return { ok: false, error: getResult.error ?? 'Could not load dashboard', toolExecutions };
    }

    const extracted = extractDashboardFromGetByUid(getResult.text);
    if (!extracted?.dashboard) {
        return { ok: false, error: 'Could not parse dashboard JSON', toolExecutions };
    }

    const baseline = extracted.dashboard;
    setPanelFixBaseline(baseline);

    const resolved = resolvePanelForScopedFix(baseline, scope);
    if (!resolved.ok) {
        const hint =
            resolved.suggestions?.length ?
                `\n\nPanels on this dashboard:\n${resolved.suggestions.map((s) => `- ${s}`).join('\n')}`
            :   '';
        return {
            ok: false,
            error: resolved.error + hint,
            toolExecutions,
        };
    }

    const { entry, warning } = resolved.resolved;
    const effectiveScope: ScopedPanelFixTarget = {
        dashboardUid: scope.dashboardUid,
        panelId: entry.panelId,
        panelTitle: entry.title || scope.panelTitle,
        panelArrayIndex: entry.arrayIndex,
    };
    setPanelFixScope(effectiveScope);
    setPanelFixResolvedPanel({
        panelId: entry.panelId,
        panelTitle: entry.title,
        panelArrayIndex: entry.arrayIndex,
    });

    const { panel: fixedPanel, changed, targetsFixed } = applyFluxFixesToPanel(entry.panel, {
        aggressive: true,
        dashboardTitle: typeof baseline.title === 'string' ? baseline.title : undefined,
        dashboardPanels: baseline.panels as unknown[] | undefined,
    });
    if (!changed) {
        return {
            ok: false,
            error:
                `No automatic Flux corrections matched queries on ${formatPanelTargetLabel(entry)}. ` +
                'Edit queries B–D manually in Grafana.',
            warning,
            resolvedTitle: entry.title,
            resolvedPanelId: entry.panelId,
            toolExecutions,
        };
    }

    const proposed = JSON.parse(JSON.stringify(baseline)) as Record<string, unknown>;
    if (!replacePanelInDashboard(proposed, effectiveScope, fixedPanel)) {
        return {
            ok: false,
            error: `Could not replace ${formatPanelTargetLabel(entry)} in dashboard tree`,
            toolExecutions,
        };
    }
    const { merged } = enforceScopedPanelDashboardMerge(baseline, proposed, effectiveScope);
    const toSave = stampDashboardForOverwrite(baseline, merged);

    const saveStep = pendingTool('update_dashboard');
    toolExecutions.push(saveStep);
    const savePayload = normalizeUpdateDashboardArgs({
        dashboard: toSave,
        overwrite: true,
        message: `Graft: fix Flux on ${entry.title || `panel id ${entry.panelId}`}`,
    });
    const saveResult = await callMcpTool(mcpClient, 'update_dashboard', savePayload);
    toolExecutions[toolExecutions.length - 1] = finishTool(saveStep, {
        ...saveResult,
        summary:
            saveResult.summary ??
            (saveResult.ok ? `Saved dashboard uid=${scope.dashboardUid}` : undefined),
    });

    if (!saveResult.ok) {
        return {
            ok: false,
            error: saveResult.error ?? 'update_dashboard failed',
            warning,
            resolvedTitle: entry.title,
            resolvedPanelId: entry.panelId,
            toolExecutions,
            targetsFixed,
        };
    }

    const verifyStep = pendingTool('get_dashboard_by_uid');
    toolExecutions.push(verifyStep);
    const verifyResult = await callMcpTool(mcpClient, 'get_dashboard_by_uid', { uid: scope.dashboardUid });
    toolExecutions[toolExecutions.length - 1] = finishTool(verifyStep, verifyResult);

    let verificationNote: string | undefined;
    if (!verifyResult.ok) {
        return {
            ok: false,
            error:
                'Dashboard save reported success but Graft could not re-load the dashboard to verify queries were persisted.',
            warning,
            resolvedTitle: entry.title,
            resolvedPanelId: entry.panelId,
            toolExecutions,
            targetsFixed,
        };
    }

    const verified = extractDashboardFromGetByUid(verifyResult.text);
    const reResolved = verified?.dashboard
        ? resolvePanelForScopedFix(verified.dashboard, effectiveScope)
        : null;
    const verifiedPanel =
        reResolved && reResolved.ok ? reResolved.resolved.entry.panel : fixedPanel;
    const issues = scanPanelFluxIssues(verifiedPanel);
    const version =
        typeof verified?.dashboard?.version === 'number' ? verified.dashboard.version : undefined;
    verificationNote = formatPanelVerificationBlock(issues, { savedVersion: version });

    if (panelPeerBandTargetsStillStale(verifiedPanel)) {
        return {
            ok: false,
            error:
                'Dashboard saved but queries still use OR filters, r._measurement (drops all rows), or lack per-branch aggregateWindow. ' +
                'Confirm Graft build 72+ (hard refresh), then retry the panel fix.',
            warning,
            resolvedTitle: entry.title,
            resolvedPanelId: entry.panelId,
            toolExecutions,
            targetsFixed,
            verificationNote,
        };
    }

    if (issues.length > 0) {
        return {
            ok: false,
            error: 'Dashboard saved but panel queries still fail static checks.',
            warning,
            resolvedTitle: entry.title,
            resolvedPanelId: entry.panelId,
            toolExecutions,
            targetsFixed,
            verificationNote,
        };
    }

    return {
        ok: true,
        warning,
        resolvedTitle: entry.title,
        resolvedPanelId: entry.panelId,
        toolExecutions,
        targetsFixed,
        verificationNote,
    };
}
