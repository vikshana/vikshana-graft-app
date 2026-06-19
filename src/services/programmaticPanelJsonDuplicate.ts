import type { ToolExecution } from '../types/llm.types';
import { extractDashboardFromGetByUid } from './programmaticDashboardClone';
import { callMcpTool } from './mcpToolClient';
import type { McpClient } from './dashboardChunkedUpdate';
import { stampDashboardForOverwrite } from './fluxQueryFix';
import { normalizeUpdateDashboardArgs } from './updateDashboardArgs';
import { listDashboardPanels, type DashboardPanelEntry } from './panelDiscovery';
import { parseSearchHitsFromMcpText } from './dashboardSearchParse';
import { isMachineId } from './dashboardCloneParse';
import type { PanelJsonDuplicateRequest } from './panelJsonDuplicateParse';
import { repairInfluxFluxPanel, sanitizeInfluxFluxPanel } from './sanitizeInfluxFluxPanel';

type PanelRecord = Record<string, unknown>;

export interface ProgrammaticPanelJsonDuplicateResult {
    ok: boolean;
    error?: string;
    toolExecutions: ToolExecution[];
    dashboardUid?: string;
    dashboardTitle?: string;
    sourcePanelTitle?: string;
    newPanelTitle?: string;
    version?: number;
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

function normalizeTitle(title: string): string {
    return title.trim().toLowerCase();
}

function findPanelByExactTitle(
    entries: DashboardPanelEntry[],
    title: string
): DashboardPanelEntry | undefined {
    const want = normalizeTitle(title);
    return entries.find((e) => normalizeTitle(e.title) === want);
}

function maxPanelId(entries: DashboardPanelEntry[]): number {
    let max = 0;
    for (const e of entries) {
        if (e.panelId != null && e.panelId > max) {
            max = e.panelId;
        }
    }
    return max;
}

function findModule5PeerBandPanel(entries: DashboardPanelEntry[]): DashboardPanelEntry | undefined {
    return (
        entries.find((e) => /Module\s*5\b/i.test(e.title) && /vs\.\s*Peer\s*Band/i.test(e.title)) ??
        entries.find((e) => /Module\s*5\b/i.test(e.title) && /Peer\s*Band/i.test(e.title))
    );
}

function gridPosBelowPeerBand(peerEntry: DashboardPanelEntry | undefined, panel: PanelRecord): { x: number; y: number; w: number; h: number } | null {
    if (!peerEntry?.panel?.gridPos) {
        return null;
    }
    const srcGp = panel.gridPos as { w?: number; h?: number } | undefined;
    const defaultW = typeof srcGp?.w === 'number' ? srcGp.w : 12;
    const defaultH = typeof srcGp?.h === 'number' ? srcGp.h : 10;
    const gp = peerEntry.panel.gridPos as { x?: number; y?: number; w?: number; h?: number };
    const peerW = typeof gp.w === 'number' ? gp.w : 24;
    const peerH = typeof gp.h === 'number' ? gp.h : 12;
    const peerY = typeof gp.y === 'number' ? gp.y : 0;
    const peerX = typeof gp.x === 'number' ? gp.x : 0;
    if (peerW >= 24) {
        return { x: 0, y: peerY + peerH, w: defaultW, h: defaultH };
    }
    const x = peerX + peerW;
    return { x: x >= 24 ? 0 : x, y: peerY, w: defaultW, h: defaultH };
}

function computeAppendGridPos(entries: DashboardPanelEntry[], panel: PanelRecord): { x: number; y: number; w: number; h: number } {
    const title = typeof panel.title === 'string' ? panel.title : '';
    if (/Module\s*5\b/i.test(title) && /RandomForest/i.test(title)) {
        const below = gridPosBelowPeerBand(findModule5PeerBandPanel(entries), panel);
        if (below) {
            return below;
        }
    }
    const defaultW = 12;
    const defaultH = 8;
    let maxY = 0;
    for (const e of entries) {
        const gp = e.panel.gridPos as { y?: number; h?: number } | undefined;
        if (gp && typeof gp.y === 'number' && typeof gp.h === 'number') {
            maxY = Math.max(maxY, gp.y + gp.h);
        }
    }
    const srcGp = panel.gridPos as { w?: number; h?: number } | undefined;
    return {
        x: 0,
        y: maxY,
        w: typeof srcGp?.w === 'number' ? srcGp.w : defaultW,
        h: typeof srcGp?.h === 'number' ? srcGp.h : defaultH,
    };
}

async function resolveDashboard(
    mcpClient: McpClient,
    request: PanelJsonDuplicateRequest,
    toolExecutions: ToolExecution[]
): Promise<{ uid?: string; title?: string; error?: string }> {
    if (request.dashboardUid) {
        return { uid: request.dashboardUid };
    }

    const query =
        request.dashboardTitle?.trim() ||
        (request.machineId && isMachineId(request.machineId) ? request.machineId : undefined);
    if (!query) {
        return { error: 'Missing dashboard name, uid, or machine id' };
    }

    const searchStep = pendingTool('search_dashboards');
    toolExecutions.push(searchStep);
    const search = await callMcpTool(mcpClient, 'search_dashboards', { query });
    toolExecutions[toolExecutions.length - 1] = finishTool(searchStep, search);
    if (!search.ok) {
        return { error: search.error ?? 'search_dashboards failed' };
    }

    const hits = parseSearchHitsFromMcpText(search.text);
    const wantTitle = request.dashboardTitle ? normalizeTitle(request.dashboardTitle) : undefined;
    const match =
        (wantTitle
            ? hits.find((h) => normalizeTitle(h.title) === wantTitle)
            : undefined) ??
        hits.find((h) => request.machineId && h.title.includes(request.machineId)) ??
        hits[0];

    if (!match?.uid) {
        return { error: `No dashboard found for "${query}"` };
    }
    return { uid: match.uid, title: match.title };
}

export async function runProgrammaticPanelJsonDuplicate(
    mcpClient: McpClient,
    request: PanelJsonDuplicateRequest
): Promise<ProgrammaticPanelJsonDuplicateResult> {
    const toolExecutions: ToolExecution[] = [];

    const resolved = await resolveDashboard(mcpClient, request, toolExecutions);
    if (!resolved.uid) {
        return { ok: false, error: resolved.error, toolExecutions };
    }

    const getStep = pendingTool('get_dashboard_by_uid');
    toolExecutions.push(getStep);
    const fetch = await callMcpTool(mcpClient, 'get_dashboard_by_uid', { uid: resolved.uid });
    toolExecutions[toolExecutions.length - 1] = finishTool(getStep, fetch);
    if (!fetch.ok) {
        return {
            ok: false,
            error: fetch.error ?? 'Could not load dashboard',
            toolExecutions,
            dashboardUid: resolved.uid,
        };
    }

    const extracted = extractDashboardFromGetByUid(fetch.text);
    if (!extracted?.dashboard) {
        return {
            ok: false,
            error: 'Could not parse dashboard JSON',
            toolExecutions,
            dashboardUid: resolved.uid,
        };
    }

    const baseline = extracted.dashboard;
    const dashboardTitle = typeof baseline.title === 'string' ? baseline.title : resolved.title;
    const proposed = JSON.parse(JSON.stringify(baseline)) as Record<string, unknown>;
    const entries = listDashboardPanels(proposed.panels);

    if (!findPanelByExactTitle(entries, request.sourcePanelTitle)) {
        return {
            ok: false,
            error: `No panel titled "${request.sourcePanelTitle}" on dashboard \`${resolved.uid}\`${dashboardTitle ? ` (${dashboardTitle})` : ''}.`,
            toolExecutions,
            dashboardUid: resolved.uid,
            dashboardTitle,
            sourcePanelTitle: request.sourcePanelTitle,
        };
    }

    const nextId = maxPanelId(entries) + 1;
    const sanitized = sanitizeInfluxFluxPanel(request.panelJson) as PanelRecord;
    const repaired = repairInfluxFluxPanel(sanitized, baseline.panels as unknown[] | undefined);
    const newPanel = repaired.panel as PanelRecord;
    newPanel.id = nextId;
    newPanel.gridPos = computeAppendGridPos(entries, newPanel);

    const panels = proposed.panels;
    if (!Array.isArray(panels)) {
        proposed.panels = [newPanel];
    } else {
        panels.push(newPanel);
    }

    const newPanelTitle = typeof newPanel.title === 'string' ? newPanel.title : undefined;

    const saveStep = pendingTool('update_dashboard');
    toolExecutions.push(saveStep);
    const savePayload = normalizeUpdateDashboardArgs({
        dashboard: stampDashboardForOverwrite(baseline, proposed),
        overwrite: true,
        message: `Graft: duplicate "${request.sourcePanelTitle}" with pasted panel JSON → "${newPanelTitle ?? 'new panel'}"`,
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
            sourcePanelTitle: request.sourcePanelTitle,
            newPanelTitle,
        };
    }

    const versionMatch = saveResult.text?.match(/"version"\s*:\s*(\d+)/);
    const version = versionMatch ? Number(versionMatch[1]) : undefined;

    return {
        ok: true,
        toolExecutions,
        dashboardUid: resolved.uid,
        dashboardTitle,
        sourcePanelTitle: request.sourcePanelTitle,
        newPanelTitle,
        version,
    };
}

export function formatPanelJsonDuplicateReply(
    result: ProgrammaticPanelJsonDuplicateResult,
    buildNumber: number
): string {
    if (!result.ok) {
        return (
            `### Could not add panel from JSON (Graft build ${buildNumber})\n\n` +
            `${result.error ?? 'Unknown error'}\n\n` +
            (result.sourcePanelTitle ? `**Source panel:** ${result.sourcePanelTitle}\n\n` : '') +
            `**Tip:** Name the dashboard (e.g. \`2406-176021 / Exsolve\`), the panel to duplicate, and paste the full panel \`{ ... }\` after **with this json**. ` +
            `Do not rely on cross-machine panel copy for same-dashboard JSON paste.`
        );
    }

    return (
        `### Done (panel added from JSON) (Graft build ${buildNumber})\n\n` +
        `- **Dashboard:** ${result.dashboardTitle ?? result.dashboardUid} (\`${result.dashboardUid}\`)\n` +
        `- **Duplicated from:** ${result.sourcePanelTitle}\n` +
        `- **New panel:** ${result.newPanelTitle ?? '(see dashboard)'}\n` +
        (result.version != null ? `- **Version:** ${result.version}\n` : '') +
        `\nHard-refresh the dashboard (**Cmd+Shift+R**) and set the time range for your incident window.`
    );
}
