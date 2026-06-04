import type { ToolExecution } from '../types/llm.types';
import { extractDashboardFromGetByUid } from './programmaticDashboardClone';
import { callMcpTool } from './mcpToolClient';
import type { McpClient } from './dashboardChunkedUpdate';
import { stampDashboardForOverwrite } from './fluxQueryFix';
import { normalizeUpdateDashboardArgs } from './updateDashboardArgs';
import { listDashboardPanels, type DashboardPanelEntry } from './panelDiscovery';
import { parseSearchHitsFromMcpText } from './dashboardSearchParse';
import { isMachineId } from './dashboardCloneParse';
import type { InfluxPanelRepairRequest } from './influxPanelRepairParse';
import { repairInfluxFluxPanel } from './sanitizeInfluxFluxPanel';
import { scanPanelFluxIssues } from './panelFluxVerification';
import { panelFluxOnPrometheusDatasource } from './fluxPeerBandFix';
import { replacePanelInDashboard, type ScopedPanelFixTarget } from './panelFixScope';

type PanelRecord = Record<string, unknown>;

export interface ProgrammaticInfluxPanelRepairResult {
    ok: boolean;
    error?: string;
    toolExecutions: ToolExecution[];
    dashboardUid?: string;
    dashboardTitle?: string;
    panelTitle?: string;
    fixes?: string[];
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
    return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

async function resolveDashboard(
    mcpClient: McpClient,
    request: InfluxPanelRepairRequest,
    toolExecutions: ToolExecution[]
): Promise<{ uid?: string; title?: string; error?: string }> {
    if (request.dashboardUid) {
        return { uid: request.dashboardUid };
    }
    const query =
        request.dashboardTitle?.trim() ||
        (request.machineId && isMachineId(request.machineId) ? request.machineId : undefined);
    if (!query) {
        return { error: 'Missing dashboard uid or name' };
    }

    const searchStep = pendingTool('search_dashboards');
    toolExecutions.push(searchStep);
    const search = await callMcpTool(mcpClient, 'search_dashboards', { query });
    toolExecutions[toolExecutions.length - 1] = finishTool(searchStep, search);
    if (!search.ok) {
        return { error: search.error ?? 'search_dashboards failed' };
    }

    const hits = parseSearchHitsFromMcpText(search.text);
    const want = request.dashboardTitle ? normalizeTitle(request.dashboardTitle) : undefined;
    const match =
        (want ? hits.find((h) => normalizeTitle(h.title) === want) : undefined) ??
        hits.find((h) => request.machineId && h.title.includes(request.machineId)) ??
        hits[0];

    if (!match?.uid) {
        return { error: `No dashboard found for "${query}"` };
    }
    return { uid: match.uid, title: match.title };
}

function findPanelEntry(
    entries: DashboardPanelEntry[],
    request: InfluxPanelRepairRequest
): DashboardPanelEntry | undefined {
    if (request.panelId != null) {
        return entries.find((e) => e.panelId === request.panelId);
    }
    if (!request.panelTitle) {
        return undefined;
    }
    const want = normalizeTitle(request.panelTitle);
    const exact = entries.find((e) => normalizeTitle(e.title) === want);
    if (exact) {
        return exact;
    }
    return entries.find(
        (e) =>
            normalizeTitle(e.title).includes(want) ||
            want.includes(normalizeTitle(e.title)) ||
            (/randomforest/i.test(want) && /randomforest/i.test(e.title))
    );
}

export async function runProgrammaticInfluxPanelRepair(
    mcpClient: McpClient,
    request: InfluxPanelRepairRequest
): Promise<ProgrammaticInfluxPanelRepairResult> {
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
        return { ok: false, error: 'Could not parse dashboard JSON', toolExecutions };
    }

    const baseline = extracted.dashboard;
    const dashboardTitle = typeof baseline.title === 'string' ? baseline.title : resolved.title;
    const entries = listDashboardPanels(baseline.panels);
    const entry = findPanelEntry(entries, request);
    if (!entry) {
        return {
            ok: false,
            error: `Panel not found: ${request.panelTitle ?? `id ${request.panelId}`}`,
            toolExecutions,
            dashboardUid: resolved.uid,
            dashboardTitle,
        };
    }

    const repair = repairInfluxFluxPanel(entry.panel as PanelRecord, baseline.panels);
    if (!repair.changed && !panelFluxOnPrometheusDatasource(entry.panel as PanelRecord)) {
        return {
            ok: true,
            toolExecutions,
            dashboardUid: resolved.uid,
            dashboardTitle,
            panelTitle: entry.title,
            fixes: ['No changes required — panel datasource already matches Flux setup'],
        };
    }

    const proposed = JSON.parse(JSON.stringify(baseline)) as Record<string, unknown>;
    const scope: ScopedPanelFixTarget = {
        dashboardUid: resolved.uid,
        panelId: entry.panelId,
        panelTitle: entry.title,
        panelArrayIndex: entry.arrayIndex,
    };
    if (!replacePanelInDashboard(proposed, scope, repair.panel)) {
        return {
            ok: false,
            error: 'Could not replace panel in dashboard',
            toolExecutions,
            dashboardUid: resolved.uid,
            panelTitle: entry.title,
        };
    }

    const issues = scanPanelFluxIssues(repair.panel);
    const blocking = issues.filter(
        (i) =>
            i.issue.includes('Prometheus') ||
            i.issue.includes('expr') ||
            i.issue.includes('missing query')
    );
    const promIssue = blocking[0];
    if (promIssue) {
        return {
            ok: false,
            error: promIssue.issue,
            toolExecutions,
            dashboardUid: resolved.uid,
            dashboardTitle,
            panelTitle: entry.title,
            fixes: repair.fixes,
        };
    }

    const saveStep = pendingTool('update_dashboard');
    toolExecutions.push(saveStep);
    const savePayload = normalizeUpdateDashboardArgs({
        dashboard: stampDashboardForOverwrite(baseline, proposed),
        overwrite: true,
        message: `Graft: repair Influx Flux panel "${entry.title}"`,
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
            panelTitle: entry.title,
            fixes: repair.fixes,
        };
    }

    const versionMatch = saveResult.text?.match(/"version"\s*:\s*(\d+)/);
    const version = versionMatch ? Number(versionMatch[1]) : undefined;

    return {
        ok: true,
        toolExecutions,
        dashboardUid: resolved.uid,
        dashboardTitle,
        panelTitle: entry.title,
        fixes: repair.fixes,
        version,
    };
}

export function formatInfluxPanelRepairReply(
    result: ProgrammaticInfluxPanelRepairResult,
    buildNumber: number
): string {
    if (!result.ok) {
        return (
            `### Could not repair Flux panel (Graft build ${buildNumber})\n\n` +
            `${result.error ?? 'Unknown error'}\n\n` +
            (result.panelTitle ? `**Panel:** ${result.panelTitle}\n\n` : '') +
            `**Cause:** Flux queries (\`from(bucket: v.bucket)\`) must use the **same Influx datasource** as your working peer-band panel — not Prometheus. ` +
            `Prometheus returns \`parse error: unexpected identifier "v"\`.\n\n` +
            (result.fixes?.length ? `**Attempted:** ${result.fixes.join('; ')}\n\n` : '') +
            `In Grafana: open a working Module 5 peer-band panel → Query → note datasource → set the RandomForest panel to that datasource.`
        );
    }

    const fixLines =
        result.fixes && result.fixes.length > 0
            ? result.fixes.map((f) => `- ${f}`).join('\n')
            : '- Repaired panel JSON for Influx Flux';

    return (
        `### Done (Flux panel repaired) (Graft build ${buildNumber})\n\n` +
        `- **Dashboard:** ${result.dashboardTitle ?? result.dashboardUid} (\`${result.dashboardUid}\`)\n` +
        `- **Panel:** ${result.panelTitle}\n` +
        (result.version != null ? `- **Version:** ${result.version}\n` : '') +
        `\n**Changes:**\n${fixLines}\n\n` +
        `Hard-refresh (**Cmd+Shift+R**). Legend should read **Module 5 (Actual)**, **Upper/Lower Bound (RF)**, **Expected (RF)** — not \`_value {_start=...}\`. ` +
        `If names are still wrong, run this same fix prompt again after confirming build **${buildNumber}** or newer.`
    );
}
