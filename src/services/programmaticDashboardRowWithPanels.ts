import type { ToolExecution } from '../types/llm.types';
import { extractDashboardFromGetByUid } from './programmaticDashboardClone';
import { callMcpTool } from './mcpToolClient';
import type { McpClient } from './dashboardChunkedUpdate';
import { stampDashboardForOverwrite } from './fluxQueryFix';
import { normalizeUpdateDashboardArgs } from './updateDashboardArgs';
import { listDashboardPanels, type DashboardPanelEntry } from './panelDiscovery';
import { inferMachineIdFromDashboardTitle, resolveDashboardUid } from './programmaticDashboardResolve';
import { draftPanelForCreate } from './programmaticPanelCreate';
import type { PanelCreateRequest } from './panelCreateParse';
import type { DashboardRowWithPanelsRequest } from './dashboardRowWithPanelsParse';

type PanelRecord = Record<string, unknown>;

export interface DashboardRowWithPanelsResult {
    ok: boolean;
    error?: string;
    clarification?: boolean;
    toolExecutions: ToolExecution[];
    dashboardUid?: string;
    dashboardTitle?: string;
    version?: number;
    rowTitle?: string;
    rowId?: number;
    createdPanelTitles?: string[];
}

const ROW_HEIGHT = 1;
const ROW_WIDTH = 24;
const CHILD_HEIGHT = 8;

function pendingTool(name: string): ToolExecution {
    return { name, status: 'pending' };
}

function finishTool(step: ToolExecution, outcome: { ok: boolean; error?: string; summary?: string }): ToolExecution {
    return { ...step, status: outcome.ok ? 'success' : 'error', error: outcome.error, summary: outcome.summary };
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

function maxTopLevelBottomY(panels: PanelRecord[]): number {
    let max = 0;
    for (const panel of panels) {
        const gp = panel.gridPos as { y?: number; h?: number } | undefined;
        if (gp && typeof gp.y === 'number' && typeof gp.h === 'number') {
            max = Math.max(max, gp.y + gp.h);
        }
    }
    return max;
}

function findTopLevelRowByTitle(panels: PanelRecord[], rowTitle: string): PanelRecord | undefined {
    const key = rowTitle.trim().toLowerCase();
    return panels.find(
        (p) => p.type === 'row' && typeof p.title === 'string' && p.title.trim().toLowerCase() === key
    );
}

export async function runProgrammaticDashboardRowWithPanels(
    mcpClient: McpClient,
    request: DashboardRowWithPanelsRequest,
    opts?: { contextDashboardUid?: string }
): Promise<DashboardRowWithPanelsResult> {
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
    const topLevel = Array.isArray(baseline.panels) ? [...(baseline.panels as PanelRecord[])] : [];
    if (findTopLevelRowByTitle(topLevel, request.rowTitle)) {
        return {
            ok: false,
            error: `Row **${request.rowTitle}** already exists on the dashboard.`,
            toolExecutions,
            dashboardUid: resolved.uid,
            dashboardTitle,
        };
    }

    const entries = listDashboardPanels(baseline.panels);
    const machineId = request.machineId ?? inferMachineIdFromDashboardTitle(dashboardTitle);
    const rowY = maxTopLevelBottomY(topLevel);
    const childY = rowY + ROW_HEIGHT;
    const childWidth = Math.floor(ROW_WIDTH / request.panelCount);
    const createdPanelTitles: string[] = [];
    let nextId = maxPanelId(entries) + 1;
    const nestedPanels: PanelRecord[] = [];

    for (let i = 0; i < request.panelCount; i++) {
        const panelTitle = `${request.rowTitle} ${i + 1}`;
        const panelRequest: PanelCreateRequest = {
            panelTitle,
            panelType: 'timeseries',
            dashboardUid: resolved.uid,
            machineId,
        };
        const draft = await draftPanelForCreate(mcpClient, panelRequest, {
            entries,
            baselinePanels: baseline.panels,
            machineId,
            dashboardTitle,
            panelId: nextId,
            gridPos: { x: i * childWidth, y: childY, w: childWidth, h: CHILD_HEIGHT },
            toolExecutions,
        });
        nestedPanels.push(draft);
        createdPanelTitles.push(panelTitle);
        entries.push({ panel: draft, arrayIndex: topLevel.length, panelId: nextId, title: panelTitle, path: [topLevel.length, i] });
        nextId += 1;
    }

    const rowPanel: PanelRecord = {
        id: nextId,
        type: 'row',
        title: request.rowTitle,
        collapsed: false,
        gridPos: { x: 0, y: rowY, w: ROW_WIDTH, h: ROW_HEIGHT },
        panels: nestedPanels,
    };

    const proposed = JSON.parse(JSON.stringify(baseline)) as Record<string, unknown>;
    const proposedTop = Array.isArray(proposed.panels) ? [...(proposed.panels as PanelRecord[])] : [];
    proposedTop.push(rowPanel);
    proposed.panels = proposedTop;

    const saveStep = pendingTool('update_dashboard');
    toolExecutions.push(saveStep);
    const savePayload = normalizeUpdateDashboardArgs({
        dashboard: stampDashboardForOverwrite(baseline, proposed),
        overwrite: true,
        message: `Graft: create row "${request.rowTitle}" with ${request.panelCount} panels`,
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
            rowTitle: request.rowTitle,
            createdPanelTitles,
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
            rowTitle: request.rowTitle,
            createdPanelTitles,
        };
    }

    const verified = extractDashboardFromGetByUid(verify.text);
    const version = typeof verified?.dashboard?.version === 'number' ? verified.dashboard.version : undefined;
    const verifiedTop = Array.isArray(verified?.dashboard?.panels)
        ? (verified.dashboard.panels as PanelRecord[])
        : [];
    const savedRow = findTopLevelRowByTitle(verifiedTop, request.rowTitle);
    const nestedCount = Array.isArray(savedRow?.panels) ? savedRow.panels.length : 0;
    if (!savedRow || nestedCount < request.panelCount) {
        return {
            ok: false,
            error: `Save reported success but row **${request.rowTitle}** was not found with ${request.panelCount} panel(s).`,
            toolExecutions,
            dashboardUid: resolved.uid,
            dashboardTitle,
            version,
            rowTitle: request.rowTitle,
            createdPanelTitles,
        };
    }

    return {
        ok: true,
        toolExecutions,
        dashboardUid: resolved.uid,
        dashboardTitle,
        version,
        rowTitle: request.rowTitle,
        rowId: typeof savedRow.id === 'number' ? savedRow.id : undefined,
        createdPanelTitles,
    };
}

export function formatDashboardRowWithPanelsReply(result: DashboardRowWithPanelsResult, buildNumber: number): string {
    if (result.ok) {
        const panelLines = (result.createdPanelTitles ?? []).map((t) => `- **${t}**`).join('\n');
        return (
            `### Row and panels created (Graft build ${buildNumber})\n\n` +
            `- **Row:** **${result.rowTitle ?? '?'}**` +
            (result.rowId != null ? ` (id ${result.rowId})` : '') +
            `\n- **Panels:**\n${panelLines}` +
            `\n- **Dashboard:** ${result.dashboardTitle ?? '(untitled)'} — uid \`${result.dashboardUid ?? '?'}\`` +
            (result.version != null ? `\n- **Version:** ${result.version}` : '') +
            `\n\nHard-refresh the dashboard (**Cmd+Shift+R**) to see the new row.`
        );
    }
    return `### Could not create row and panels\n\n${result.error ?? 'Unknown error.'}`;
}
