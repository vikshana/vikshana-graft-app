import type { ToolExecution } from '../types/llm.types';
import { extractDashboardFromGetByUid } from './programmaticDashboardClone';
import { callMcpTool } from './mcpToolClient';
import type { McpClient } from './dashboardChunkedUpdate';
import { applyFluxFixesToPanel, stampDashboardForOverwrite } from './fluxQueryFix';
import { formatPanelTargetLabel, listDashboardPanels, findPeerBandPanels, type DashboardPanelEntry } from './panelDiscovery';
import { replacePanelAtPath, replacePanelInDashboard, type ScopedPanelFixTarget } from './panelFixScope';
import { setPanelFixBaseline } from './panelFixSessionStorage';
import { normalizeUpdateDashboardArgs } from './updateDashboardArgs';
import { scanPanelFluxIssues } from './panelFluxVerification';
import { findReferenceFluxPeerBandPanel, panelPeerBandTargetsStillStale } from './fluxPeerBandFix';
import type { BulkPeerBandFixRequest } from './bulkPeerBandFixParse';

type PanelRecord = Record<string, unknown>;

export interface BulkPeerBandPanelResult {
    entry: DashboardPanelEntry;
    changed: boolean;
    targetsFixed: number;
    staleAfterFix: boolean;
    issues: ReturnType<typeof scanPanelFluxIssues>;
}

export interface ProgrammaticBulkPeerBandFixResult {
    ok: boolean;
    error?: string;
    toolExecutions: ToolExecution[];
    panelsMatched: number;
    panelsChanged: number;
    targetsFixed: number;
    panelResults: BulkPeerBandPanelResult[];
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

function scopeForEntry(entry: DashboardPanelEntry, dashboardUid: string): ScopedPanelFixTarget {
    return {
        dashboardUid,
        panelId: entry.panelId,
        panelTitle: entry.title,
        panelArrayIndex: entry.arrayIndex,
    };
}

function applyBulkFixesToDashboard(
    baseline: Record<string, unknown>,
    entries: DashboardPanelEntry[],
    dashboardUid: string,
    dashboardTitle?: string,
    reference?: { panel: PanelRecord; targetA: PanelRecord }
): { proposed: Record<string, unknown>; panelResults: BulkPeerBandPanelResult[]; panelsChanged: number; targetsFixed: number } {
    const proposed = JSON.parse(JSON.stringify(baseline)) as Record<string, unknown>;
    const panelResults: BulkPeerBandPanelResult[] = [];
    let panelsChanged = 0;
    let targetsFixed = 0;

    for (const entry of entries) {
        const { panel: fixedPanel, changed, targetsFixed: fixedCount } = applyFluxFixesToPanel(entry.panel, {
            aggressive: true,
            dashboardTitle,
            referenceTarget: reference?.targetA,
            referencePanel: reference?.panel,
        });
        const staleAfterFix = panelPeerBandTargetsStillStale(fixedPanel);
        const issues = scanPanelFluxIssues(fixedPanel);
        panelResults.push({
            entry,
            changed,
            targetsFixed: fixedCount,
            staleAfterFix,
            issues,
        });

        if (changed && fixedCount > 0 && !staleAfterFix) {
            panelsChanged += 1;
            targetsFixed += fixedCount;
            const scope = scopeForEntry(entry, dashboardUid);
            const replaced =
                replacePanelAtPath(proposed, entry.path, fixedPanel) ||
                replacePanelInDashboard(proposed, scope, fixedPanel);
            if (!replaced) {
                return {
                    proposed: baseline,
                    panelResults,
                    panelsChanged: 0,
                    targetsFixed: 0,
                };
            }
        }
    }

    return { proposed, panelResults, panelsChanged, targetsFixed };
}

export async function runProgrammaticBulkPeerBandFix(
    mcpClient: McpClient,
    request: BulkPeerBandFixRequest
): Promise<ProgrammaticBulkPeerBandFixResult> {
    const toolExecutions: ToolExecution[] = [];

    const getStep = pendingTool('get_dashboard_by_uid');
    toolExecutions.push(getStep);
    const getResult = await callMcpTool(mcpClient, 'get_dashboard_by_uid', { uid: request.dashboardUid });
    toolExecutions[toolExecutions.length - 1] = finishTool(getStep, getResult);

    if (!getResult.ok) {
        return {
            ok: false,
            error: getResult.error ?? 'Could not load dashboard',
            toolExecutions,
            panelsMatched: 0,
            panelsChanged: 0,
            targetsFixed: 0,
            panelResults: [],
        };
    }

    const extracted = extractDashboardFromGetByUid(getResult.text);
    if (!extracted?.dashboard) {
        return {
            ok: false,
            error: 'Could not parse dashboard JSON',
            toolExecutions,
            panelsMatched: 0,
            panelsChanged: 0,
            targetsFixed: 0,
            panelResults: [],
        };
    }

    const baseline = extracted.dashboard;
    setPanelFixBaseline(baseline);
    const dashboardTitle = typeof baseline.title === 'string' ? baseline.title : undefined;
    const entries = listDashboardPanels(baseline.panels);
    const peerEntries = findPeerBandPanels(entries, request.titleContains);
    const reference = findReferenceFluxPeerBandPanel(
        peerEntries.map((e) => e.panel).concat(entries.map((e) => e.panel))
    );

    if (peerEntries.length === 0) {
        return {
            ok: false,
            error:
                `No panels matched title containing "${request.titleContains}" on dashboard uid \`${request.dashboardUid}\`.`,
            toolExecutions,
            panelsMatched: 0,
            panelsChanged: 0,
            targetsFixed: 0,
            panelResults: [],
        };
    }

    const { proposed, panelResults, panelsChanged, targetsFixed } = applyBulkFixesToDashboard(
        baseline,
        peerEntries,
        request.dashboardUid,
        dashboardTitle,
        reference
    );

    const promStillStale = panelResults.filter((r) => r.staleAfterFix);
    if (promStillStale.length > 0 && panelsChanged === 0) {
        return {
            ok: false,
            error:
                `${promStillStale.length} panel(s) still use Prometheus PromQL and were not converted to Flux` +
                (reference ? '.' : ' — could not find a working Module 5 Flux reference panel on this dashboard.'),
            toolExecutions,
            panelsMatched: peerEntries.length,
            panelsChanged: 0,
            targetsFixed: 0,
            panelResults,
        };
    }

    if (panelsChanged === 0) {
        const unchanged = panelResults.filter((r) => r.staleAfterFix).map((r) => formatPanelTargetLabel(r.entry));
        return {
            ok: false,
            error:
                unchanged.length > 0
                    ? `Matched ${peerEntries.length} peer-band panel(s) but none needed changes. Stale: ${unchanged.join('; ')}`
                    : `Matched ${peerEntries.length} peer-band panel(s) but Graft found nothing to rewrite.`,
            toolExecutions,
            panelsMatched: peerEntries.length,
            panelsChanged: 0,
            targetsFixed: 0,
            panelResults,
        };
    }

    const toSave = stampDashboardForOverwrite(baseline, proposed);
    const saveStep = pendingTool('update_dashboard');
    toolExecutions.push(saveStep);
    const savePayload = normalizeUpdateDashboardArgs({
        dashboard: toSave,
        overwrite: true,
        message: `Graft: bulk peer-band Flux fix (${panelsChanged} panels)`,
    });
    const saveResult = await callMcpTool(mcpClient, 'update_dashboard', savePayload);
    toolExecutions[toolExecutions.length - 1] = finishTool(saveStep, {
        ...saveResult,
        summary:
            saveResult.summary ??
            (saveResult.ok ? `Saved dashboard uid=${request.dashboardUid}` : undefined),
    });

    if (!saveResult.ok) {
        return {
            ok: false,
            error: saveResult.error ?? 'update_dashboard failed',
            toolExecutions,
            panelsMatched: peerEntries.length,
            panelsChanged,
            targetsFixed,
            panelResults,
        };
    }

    const verifyStep = pendingTool('get_dashboard_by_uid');
    toolExecutions.push(verifyStep);
    const verifyResult = await callMcpTool(mcpClient, 'get_dashboard_by_uid', { uid: request.dashboardUid });
    toolExecutions[toolExecutions.length - 1] = finishTool(verifyStep, verifyResult);

    if (!verifyResult.ok) {
        return {
            ok: false,
            error: 'Dashboard save reported success but Graft could not re-load the dashboard to verify.',
            toolExecutions,
            panelsMatched: peerEntries.length,
            panelsChanged,
            targetsFixed,
            panelResults,
        };
    }

    const verified = extractDashboardFromGetByUid(verifyResult.text);
    const verifiedEntries = verified?.dashboard
        ? findPeerBandPanels(listDashboardPanels(verified.dashboard.panels), request.titleContains)
        : [];
    const stalePanels = verifiedEntries.filter((e) => panelPeerBandTargetsStillStale(e.panel));
    const version =
        typeof verified?.dashboard?.version === 'number' ? verified.dashboard.version : undefined;

    const lines = panelResults
        .filter((r) => r.changed)
        .map((r) => `- ${formatPanelTargetLabel(r.entry)} (${r.targetsFixed} targets)`);
    const verificationNote =
        `**Saved:** ${panelsChanged} “vs. Peer Band” panel(s) updated on dashboard version **${version ?? '?'}**.\n` +
        `${lines.join('\n')}\n` +
        (stalePanels.length > 0
            ? `\n**Still stale after save:** ${stalePanels.map((e) => e.title).join('; ')}`
            : '\nAll updated panels passed static Flux checks.');

    if (stalePanels.length > 0) {
        return {
            ok: false,
            error: `${stalePanels.length} peer-band panel(s) still fail static checks after save.`,
            toolExecutions,
            panelsMatched: peerEntries.length,
            panelsChanged,
            targetsFixed,
            panelResults,
            verificationNote,
        };
    }

    return {
        ok: true,
        toolExecutions,
        panelsMatched: peerEntries.length,
        panelsChanged,
        targetsFixed,
        panelResults,
        verificationNote,
    };
}
