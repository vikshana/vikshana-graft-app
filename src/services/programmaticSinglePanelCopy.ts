import type { ToolExecution } from '../types/llm.types';
import {
    extractDashboardFromGetByUid,
    replaceMachineLabelsInValue,
} from './programmaticDashboardClone';
import { callMcpTool } from './mcpToolClient';
import type { McpClient } from './dashboardChunkedUpdate';
import { stampDashboardForOverwrite } from './fluxQueryFix';
import { normalizeUpdateDashboardArgs } from './updateDashboardArgs';
import { listDashboardPanels, type DashboardPanelEntry } from './panelDiscovery';
import { replacePanelAtPath, replacePanelInDashboard, type ScopedPanelFixTarget } from './panelFixScope';
import { parseSearchHitsFromMcpText } from './dashboardSearchParse';
import { isMachineId } from './dashboardCloneParse';
import type { SinglePanelCopyRequest } from './singlePanelCopyParse';
import { inferMachineIdFromDashboardTitle } from './programmaticPeerBandPanelCopy';

type PanelRecord = Record<string, unknown>;

export interface ProgrammaticSinglePanelCopyResult {
    ok: boolean;
    error?: string;
    toolExecutions: ToolExecution[];
    panelTitle?: string;
    sourceDashboardUid?: string;
    sourceDashboardTitle?: string;
    targetDashboardUid?: string;
    targetDashboardTitle?: string;
    sourceMachine?: string;
    targetMachine?: string;
    action?: 'replaced' | 'appended';
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
    const exact = entries.find((e) => normalizeTitle(e.title) === want);
    if (exact) {
        return exact;
    }
    return entries.find(
        (e) =>
            normalizeTitle(e.title).includes(want) ||
            want.includes(normalizeTitle(e.title)) ||
            (/total\s*cu\s*mass/i.test(want) && /total\s*cu\s*mass/i.test(e.title))
    );
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

function computeAppendGridPos(entries: DashboardPanelEntry[], panel: PanelRecord): { x: number; y: number; w: number; h: number } {
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

function preparePanelForCopy(panel: PanelRecord, newPanelId: number): PanelRecord {
    const copy = JSON.parse(JSON.stringify(panel)) as PanelRecord;
    copy.id = newPanelId;
    return copy;
}

function appendPanelToDashboard(
    dashboard: Record<string, unknown>,
    panel: PanelRecord,
    entries: DashboardPanelEntry[]
): void {
    const panels = dashboard.panels;
    const nextPanel = { ...panel, gridPos: computeAppendGridPos(entries, panel) };
    if (!Array.isArray(panels)) {
        dashboard.panels = [nextPanel];
        return;
    }
    panels.push(nextPanel);
}

function scopeForEntry(entry: DashboardPanelEntry, dashboardUid: string): ScopedPanelFixTarget {
    return {
        dashboardUid,
        panelId: entry.panelId,
        panelTitle: entry.title,
        panelArrayIndex: entry.arrayIndex,
    };
}

function normalizeDashboardTitle(title: string): string {
    return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

async function resolveDashboardUid(
    mcpClient: McpClient,
    machineId: string | undefined,
    explicitUid: string | undefined,
    dashboardTitle: string | undefined,
    toolExecutions: ToolExecution[],
    label: string
): Promise<{ uid?: string; title?: string; error?: string }> {
    if (explicitUid) {
        return { uid: explicitUid };
    }

    const query =
        dashboardTitle?.trim() ||
        (machineId && isMachineId(machineId) ? machineId : undefined);
    if (!query) {
        return { error: `Missing ${label} dashboard uid, name, or machine id` };
    }

    const searchStep = pendingTool('search_dashboards');
    toolExecutions.push(searchStep);
    const search = await callMcpTool(mcpClient, 'search_dashboards', { query });
    toolExecutions[toolExecutions.length - 1] = finishTool(searchStep, search);
    if (!search.ok) {
        return { error: search.error ?? `search_dashboards failed for ${label}` };
    }

    const hits = parseSearchHitsFromMcpText(search.text);
    const wantTitle = dashboardTitle ? normalizeDashboardTitle(dashboardTitle) : undefined;
    const subtitle = wantTitle?.includes('/')
        ? wantTitle.split('/').pop()?.trim()
        : undefined;
    const match =
        (wantTitle ? hits.find((h) => normalizeDashboardTitle(h.title) === wantTitle) : undefined) ??
        (wantTitle
            ? hits.find((h) => normalizeDashboardTitle(h.title).includes(wantTitle))
            : undefined) ??
        (subtitle
            ? hits.find((h) => normalizeDashboardTitle(h.title).includes(subtitle))
            : undefined) ??
        (machineId
            ? hits.find(
                  (h) =>
                      h.title.includes(machineId) &&
                      (!subtitle || normalizeDashboardTitle(h.title).includes(subtitle))
              ) ??
              hits.find((h) => h.title.includes(machineId))
            : undefined) ??
        hits[0];

    if (!match?.uid) {
        return { error: `No dashboard found for ${label} (“${query}”)` };
    }
    return { uid: match.uid, title: match.title };
}

function resolveMachines(
    request: SinglePanelCopyRequest,
    sourceTitle: string | undefined,
    targetTitle: string | undefined
): { sourceMachine: string; targetMachine: string } | { error: string } {
    const sourceMachine =
        request.sourceMachineId ?? inferMachineIdFromDashboardTitle(sourceTitle ?? '') ?? undefined;
    const targetMachine =
        request.targetMachineId ?? inferMachineIdFromDashboardTitle(targetTitle ?? '') ?? undefined;

    if (!sourceMachine || !isMachineId(sourceMachine)) {
        return {
            error:
                'Could not infer source machine id. Mention the source machine (e.g. panel on 2210-177097) or use a dashboard title like "2210-177097".',
        };
    }
    if (!targetMachine || !isMachineId(targetMachine)) {
        return {
            error:
                'Could not infer target machine id. Add "with data for MACHINE" or "on the MACHINE dashboard" in your message.',
        };
    }
    return { sourceMachine, targetMachine };
}

export async function runProgrammaticSinglePanelCopy(
    mcpClient: McpClient,
    request: SinglePanelCopyRequest
): Promise<ProgrammaticSinglePanelCopyResult> {
    const toolExecutions: ToolExecution[] = [];

    const sourceResolved = await resolveDashboardUid(
        mcpClient,
        request.sourceMachineId,
        request.sourceDashboardUid,
        request.sourceDashboardTitle,
        toolExecutions,
        'source'
    );
    if (!sourceResolved.uid) {
        return { ok: false, error: sourceResolved.error, toolExecutions };
    }

    const getSourceStep = pendingTool('get_dashboard_by_uid');
    toolExecutions.push(getSourceStep);
    const sourceFetch = await callMcpTool(mcpClient, 'get_dashboard_by_uid', { uid: sourceResolved.uid });
    toolExecutions[toolExecutions.length - 1] = finishTool(getSourceStep, sourceFetch);
    if (!sourceFetch.ok) {
        return {
            ok: false,
            error: sourceFetch.error ?? 'Could not load source dashboard',
            toolExecutions,
            sourceDashboardUid: sourceResolved.uid,
        };
    }

    const sourceExtracted = extractDashboardFromGetByUid(sourceFetch.text);
    if (!sourceExtracted?.dashboard) {
        return {
            ok: false,
            error: 'Could not parse source dashboard JSON',
            toolExecutions,
            sourceDashboardUid: sourceResolved.uid,
        };
    }

    const sourceDashboard = sourceExtracted.dashboard;
    const sourceDashboardTitle =
        typeof sourceDashboard.title === 'string' ? sourceDashboard.title : sourceResolved.title;
    const sourceEntries = listDashboardPanels(sourceDashboard.panels);
    const sourcePanelEntry = findPanelByExactTitle(sourceEntries, request.panelTitle);
    if (!sourcePanelEntry) {
        return {
            ok: false,
            error:
                `No panel titled "${request.panelTitle}" on source dashboard ` +
                `\`${sourceResolved.uid}\`${sourceDashboardTitle ? ` (${sourceDashboardTitle})` : ''}.`,
            toolExecutions,
            sourceDashboardUid: sourceResolved.uid,
            sourceDashboardTitle,
            panelTitle: request.panelTitle,
        };
    }

    const targetResolved = await resolveDashboardUid(
        mcpClient,
        request.targetMachineId,
        request.targetDashboardUid,
        request.targetDashboardTitle,
        toolExecutions,
        'target'
    );
    if (!targetResolved.uid) {
        return {
            ok: false,
            error: targetResolved.error,
            toolExecutions,
            sourceDashboardUid: sourceResolved.uid,
            sourceDashboardTitle,
            panelTitle: request.panelTitle,
        };
    }

    const getTargetStep = pendingTool('get_dashboard_by_uid');
    toolExecutions.push(getTargetStep);
    const targetFetch = await callMcpTool(mcpClient, 'get_dashboard_by_uid', { uid: targetResolved.uid });
    toolExecutions[toolExecutions.length - 1] = finishTool(getTargetStep, targetFetch);
    if (!targetFetch.ok) {
        return {
            ok: false,
            error: targetFetch.error ?? 'Could not load target dashboard',
            toolExecutions,
            sourceDashboardUid: sourceResolved.uid,
            targetDashboardUid: targetResolved.uid,
            panelTitle: request.panelTitle,
        };
    }

    const targetExtracted = extractDashboardFromGetByUid(targetFetch.text);
    if (!targetExtracted?.dashboard) {
        return {
            ok: false,
            error: 'Could not parse target dashboard JSON',
            toolExecutions,
            targetDashboardUid: targetResolved.uid,
            panelTitle: request.panelTitle,
        };
    }

    const targetDashboard = targetExtracted.dashboard;
    const targetDashboardTitle =
        typeof targetDashboard.title === 'string' ? targetDashboard.title : targetResolved.title;
    const machines = resolveMachines(request, sourceDashboardTitle, targetDashboardTitle);
    if ('error' in machines) {
        return {
            ok: false,
            error: machines.error,
            toolExecutions,
            sourceDashboardUid: sourceResolved.uid,
            targetDashboardUid: targetResolved.uid,
            panelTitle: request.panelTitle,
        };
    }

    const { sourceMachine, targetMachine } = machines;
    const proposed = JSON.parse(JSON.stringify(targetDashboard)) as Record<string, unknown>;
    let entries = listDashboardPanels(proposed.panels);

    const remapped = replaceMachineLabelsInValue(
        JSON.parse(JSON.stringify(sourcePanelEntry.panel)),
        sourceMachine,
        targetMachine
    ) as PanelRecord;

    const panelTitle =
        typeof remapped.title === 'string' ? remapped.title : request.panelTitle;
    const existing = findPanelByExactTitle(entries, panelTitle);
    let action: 'replaced' | 'appended';

    if (existing && request.replaceExisting) {
        const scope = scopeForEntry(existing, targetResolved.uid);
        const replaced =
            replacePanelAtPath(proposed, existing.path, remapped) ||
            replacePanelInDashboard(proposed, scope, remapped);
        if (!replaced) {
            return {
                ok: false,
                error: `Could not replace existing panel "${panelTitle}" on target dashboard.`,
                toolExecutions,
                sourceDashboardUid: sourceResolved.uid,
                targetDashboardUid: targetResolved.uid,
                panelTitle,
            };
        }
        action = 'replaced';
    } else {
        const nextId = maxPanelId(entries) + 1;
        const prepared = preparePanelForCopy(remapped, nextId);
        entries = listDashboardPanels(proposed.panels);
        appendPanelToDashboard(proposed, prepared, entries);
        action = 'appended';
    }

    const saveStep = pendingTool('update_dashboard');
    toolExecutions.push(saveStep);
    const savePayload = normalizeUpdateDashboardArgs({
        dashboard: stampDashboardForOverwrite(targetDashboard, proposed),
        overwrite: true,
        message: `Graft: copy panel "${panelTitle}" ${sourceMachine} → ${targetMachine}`,
    });
    const saveResult = await callMcpTool(mcpClient, 'update_dashboard', savePayload);
    toolExecutions[toolExecutions.length - 1] = finishTool(saveStep, saveResult);

    if (!saveResult.ok) {
        return {
            ok: false,
            error: saveResult.error ?? 'update_dashboard failed',
            toolExecutions,
            sourceDashboardUid: sourceResolved.uid,
            sourceDashboardTitle,
            targetDashboardUid: targetResolved.uid,
            targetDashboardTitle,
            sourceMachine,
            targetMachine,
            panelTitle,
            action,
        };
    }

    const versionMatch = saveResult.text?.match(/"version"\s*:\s*(\d+)/);
    const version = versionMatch ? Number(versionMatch[1]) : undefined;

    return {
        ok: true,
        toolExecutions,
        panelTitle,
        sourceDashboardUid: sourceResolved.uid,
        sourceDashboardTitle,
        targetDashboardUid: targetResolved.uid,
        targetDashboardTitle,
        sourceMachine,
        targetMachine,
        action,
        version,
    };
}

export function formatSinglePanelCopyReply(
    result: ProgrammaticSinglePanelCopyResult,
    buildNumber: number
): string {
    if (!result.ok) {
        return (
            `### Could not copy panel (Graft build ${buildNumber})\n\n` +
            `${result.error ?? 'Unknown error'}\n\n` +
            (result.panelTitle ? `**Panel:** ${result.panelTitle}\n\n` : '') +
            `**Example:** Create a new panel on the 2505-200033 dashboard that is the same as the "Pressure" panel on 2210-177097 but with data for 2505-200033.`
        );
    }

    return (
        `### Done — one panel copied (Graft build ${buildNumber})\n\n` +
        `- **Panel:** ${result.panelTitle} (single panel only — not a full dashboard clone)\n` +
        `- **Source:** ${result.sourceDashboardTitle ?? result.sourceDashboardUid} (\`${result.sourceDashboardUid}\`)\n` +
        `- **Target:** ${result.targetDashboardTitle ?? result.targetDashboardUid} (\`${result.targetDashboardUid}\`)\n` +
        `- **Machine remap:** ${result.sourceMachine} → ${result.targetMachine}\n` +
        `- **Action:** ${result.action === 'replaced' ? 'Replaced existing panel with same title' : 'Appended new panel'}\n` +
        (result.version != null ? `- **Version:** ${result.version}\n` : '') +
        `\nHard-refresh the target dashboard to see the panel.`
    );
}
