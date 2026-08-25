import type { ToolExecution } from '../types/llm.types';
import { extractDashboardFromGetByUid } from './programmaticDashboardClone';
import { callMcpTool } from './mcpToolClient';
import type { McpClient } from './dashboardChunkedUpdate';
import { stampDashboardForOverwrite } from './fluxQueryFix';
import { normalizeUpdateDashboardArgs } from './updateDashboardArgs';
import { listDashboardPanels, type DashboardPanelEntry } from './panelDiscovery';
import { isMachineId } from './dashboardCloneParse';
import type { AddHistoryComparisonPanelRequest } from './historyComparisonPanelAddParse';
import { resolveHistoryComparisonSignal } from './historyComparisonPanelAddParse';
import { resolveDashboardUid, inferMachineIdFromDashboardTitle } from './programmaticDashboardResolve';
import { findPrometheusTemplatePanel } from './instrumentationMetricDiscovery';
import { resolvePrometheusDatasourceUid } from './prometheusDiscovery';
import { getPanelTargetList } from './fluxPeerBandFix';
import {
    isLiveHistoryComparisonPanel,
} from './modulePanelTitles';
import { MODULE_PANEL_GRID } from './programmaticModulePanelReorder';
import { parseModuleNumberFromTitle } from './modulePanelReorderParse';

type PanelRecord = Record<string, unknown>;

function escapePromqlString(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function datasourceUidOf(value: unknown): string | undefined {
    if (value && typeof value === 'object' && 'uid' in (value as Record<string, unknown>)) {
        const uid = (value as { uid?: unknown }).uid;
        return typeof uid === 'string' ? uid : undefined;
    }
    return typeof value === 'string' ? value : undefined;
}

function promUidFromDashboard(panels: unknown): string | undefined {
    const entries = listDashboardPanels(panels);
    const liveHc = entries.find((e) => isLiveHistoryComparisonPanel(e.title));
    if (liveHc) {
        for (const target of getPanelTargetList(liveHc.panel)) {
            const uid =
                datasourceUidOf((target as PanelRecord).datasource) ??
                datasourceUidOf(liveHc.panel.datasource);
            if (uid) {
                return uid;
            }
        }
    }
    const prom = findPrometheusTemplatePanel(entries);
    if (prom) {
        for (const target of getPanelTargetList(prom.panel)) {
            const uid =
                datasourceUidOf((target as PanelRecord).datasource) ??
                datasourceUidOf(prom.panel.datasource);
            if (uid) {
                return uid;
            }
        }
    }
    return undefined;
}

function buildHistoryComparisonPanel(
    machineId: string,
    signal: {
        field: string;
        panelTitle: string;
        titleBase: string;
        unit: string;
        moduleNumber?: number;
    },
    promDatasourceUid?: string
): PanelRecord {
    const field = signal.field;
    const m = escapePromqlString(machineId);
    const ds = promDatasourceUid ? { type: 'prometheus', uid: promDatasourceUid } : { type: 'prometheus' };
    const title = signal.panelTitle;
    const actualLegend = `${signal.titleBase} (Actual)`;
    return {
        id: null,
        type: 'timeseries',
        title,
        description:
            `${signal.titleBase} actual vs **RandomForest ML** bands (own 30-day history). ` +
            'Live PromQL (~35d). For older dates add the historical/Influx History Comparison panel.',
        timezone: 'browser',
        datasource: ds,
        gridPos: { h: MODULE_PANEL_GRID.h, w: MODULE_PANEL_GRID.w, x: 0, y: 0 },
        fieldConfig: {
            defaults: {
                custom: { drawStyle: 'line', spanNulls: true, showPoints: 'never' },
                unit: signal.unit,
            },
        },
        options: { legend: { displayMode: 'list', placement: 'bottom', showLegend: true } },
        targets: [
            {
                refId: 'A',
                datasource: ds,
                expr: `machine_metrics{machine="${m}",field="${field}"}`,
                legendFormat: actualLegend,
            },
            {
                refId: 'B',
                datasource: ds,
                expr: `last_over_time(machine_metric_upper_bound{machine="${m}",field="${field}"}[6m])`,
                legendFormat: 'Upper Band',
            },
            {
                refId: 'C',
                datasource: ds,
                expr: `last_over_time(machine_metric_lower_bound{machine="${m}",field="${field}"}[6m])`,
                legendFormat: 'Lower Band',
            },
            {
                refId: 'D',
                datasource: ds,
                expr: `last_over_time(machine_metric_expected{machine="${m}",field="${field}"}[6m])`,
                legendFormat: 'Expected',
            },
        ],
    };
}

export interface ProgrammaticAddHistoryComparisonPanelResult {
    ok: boolean;
    error?: string;
    toolExecutions: ToolExecution[];
    dashboardUid?: string;
    dashboardTitle?: string;
    panelTitle?: string;
    version?: number;
}

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

function gridPosForModuleBlock(entries: DashboardPanelEntry[], moduleNumber: number): {
    x: number;
    y: number;
    w: number;
    h: number;
} {
    const moduleEntries = entries.filter((e) => parseModuleNumberFromTitle(e.title) === moduleNumber);
    if (moduleEntries.length > 0) {
        let minY = Number.POSITIVE_INFINITY;
        for (const e of moduleEntries) {
            const gp = e.panel.gridPos as { y?: number } | undefined;
            if (gp && typeof gp.y === 'number') {
                minY = Math.min(minY, gp.y);
            }
        }
        if (Number.isFinite(minY)) {
            return { x: 0, y: minY, w: MODULE_PANEL_GRID.w, h: MODULE_PANEL_GRID.h };
        }
    }
    let maxY = 0;
    for (const e of entries) {
        const gp = e.panel.gridPos as { y?: number; h?: number } | undefined;
        if (gp && typeof gp.y === 'number' && typeof gp.h === 'number') {
            maxY = Math.max(maxY, gp.y + gp.h);
        }
    }
    return { x: 0, y: maxY, w: MODULE_PANEL_GRID.w, h: MODULE_PANEL_GRID.h };
}

async function resolveDashboard(
    mcpClient: McpClient,
    request: AddHistoryComparisonPanelRequest,
    toolExecutions: ToolExecution[]
): Promise<{ uid?: string; title?: string; error?: string }> {
    return resolveDashboardUid(
        mcpClient,
        {
            dashboardUid: request.dashboardUid,
            dashboardTitle: request.dashboardTitle,
            titleLabel: request.titleLabel,
            machineId: request.machineId,
        },
        toolExecutions
    );
}

export async function runProgrammaticAddHistoryComparisonPanel(
    mcpClient: McpClient,
    request: AddHistoryComparisonPanelRequest
): Promise<ProgrammaticAddHistoryComparisonPanelResult> {
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
        return { ok: false, error: fetch.error ?? 'Could not load dashboard', toolExecutions, dashboardUid: resolved.uid };
    }

    const extracted = extractDashboardFromGetByUid(fetch.text);
    if (!extracted?.dashboard) {
        return { ok: false, error: 'Could not parse dashboard JSON', toolExecutions, dashboardUid: resolved.uid };
    }

    const baseline = extracted.dashboard;
    const dashboardTitle = typeof baseline.title === 'string' ? baseline.title : resolved.title;
    const signal =
        request.signal ??
        resolveHistoryComparisonSignal({
            moduleNumber: request.moduleNumber,
            metricLabel: request.metricLabel,
        });
    if (!signal) {
        return {
            ok: false,
            error:
                'Could not resolve which signal to chart. Name a module (e.g. Module 2 Current) or a known metric (e.g. sensing voltage).',
            toolExecutions,
            dashboardUid: resolved.uid,
        };
    }
    const panelTitle = signal.panelTitle;
    const moduleNumber = signal.moduleNumber;
    const proposed = JSON.parse(JSON.stringify(baseline)) as Record<string, unknown>;
    const entries = listDashboardPanels(proposed.panels);

    const titleExists = entries.some((e) => e.title.trim().toLowerCase() === panelTitle.toLowerCase());
    const moduleHcExists =
        moduleNumber != null &&
        entries.some(
            (e) => parseModuleNumberFromTitle(e.title) === moduleNumber && isLiveHistoryComparisonPanel(e.title)
        );
    if (titleExists || moduleHcExists) {
        return {
            ok: false,
            error: `Panel "${panelTitle}" already exists.`,
            toolExecutions,
            dashboardUid: resolved.uid,
            dashboardTitle,
        };
    }

    const machineId =
        request.machineId && isMachineId(request.machineId)
            ? request.machineId
            : inferMachineIdFromDashboardTitle(dashboardTitle);
    if (!machineId) {
        return {
            ok: false,
            error:
                'Could not determine machine id from the prompt or dashboard title ' +
                `(got "${dashboardTitle ?? ''}"). Include the machine id or use a title like "2505-200033 / Keysight".`,
            toolExecutions,
            dashboardUid: resolved.uid,
            dashboardTitle,
        };
    }

    const promUid =
        promUidFromDashboard(proposed.panels) ??
        (await resolvePrometheusDatasourceUid(
            mcpClient,
            Array.isArray(proposed.panels) ? proposed.panels : [],
            toolExecutions
        ));
    if (!promUid) {
        return {
            ok: false,
            error:
                'No Prometheus datasource UID found on this dashboard or in Grafana. ' +
                'Keep at least one working Prometheus panel, or add a Prometheus datasource, then retry.',
            toolExecutions,
            dashboardUid: resolved.uid,
            dashboardTitle,
        };
    }
    const newPanel = buildHistoryComparisonPanel(machineId, signal, promUid);
    newPanel.id = maxPanelId(entries) + 1;
    newPanel.gridPos =
        moduleNumber != null
            ? gridPosForModuleBlock(entries, moduleNumber)
            : (() => {
                  let maxY = 0;
                  for (const e of entries) {
                      const gp = e.panel.gridPos as { y?: number; h?: number } | undefined;
                      if (gp && typeof gp.y === 'number' && typeof gp.h === 'number') {
                          maxY = Math.max(maxY, gp.y + gp.h);
                      }
                  }
                  return { x: 0, y: maxY, w: MODULE_PANEL_GRID.w, h: MODULE_PANEL_GRID.h };
              })();

    if (!Array.isArray(proposed.panels)) {
        proposed.panels = [newPanel];
    } else {
        (proposed.panels as PanelRecord[]).push(newPanel);
    }

    const saveStep = pendingTool('update_dashboard');
    toolExecutions.push(saveStep);
    const savePayload = normalizeUpdateDashboardArgs({
        dashboard: stampDashboardForOverwrite(baseline, proposed),
        overwrite: true,
        message: `Graft: add ${panelTitle}`,
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
        };
    }

    const versionMatch = saveResult.text?.match(/"version"\s*:\s*(\d+)/);
    const version = versionMatch ? Number(versionMatch[1]) : undefined;

    return {
        ok: true,
        toolExecutions,
        dashboardUid: resolved.uid,
        dashboardTitle,
        panelTitle,
        version,
    };
}

export function formatAddHistoryComparisonPanelReply(
    result: ProgrammaticAddHistoryComparisonPanelResult,
    buildNumber: number
): string {
    if (!result.ok) {
        return (
            `### Could not add predictive analytics panel (Graft build ${buildNumber})\n\n` +
            `${result.error ?? 'Unknown error'}\n\n` +
            `Ensure the ML exporter is writing \`machine_metric_upper_bound\`, \`machine_metric_lower_bound\`, and \`machine_metric_expected\` for this module.`
        );
    }
    return (
        `### Predictive analytics panel — saved (build ${buildNumber})\n\n` +
        `- **Dashboard:** ${result.dashboardTitle ?? result.dashboardUid} (\`${result.dashboardUid}\`)\n` +
        `- **Panel:** ${result.panelTitle}\n` +
        (result.version != null ? `- **Version:** ${result.version}\n` : '') +
        `\nHard-refresh (**Cmd+Shift+R**). Series: Actual + Upper/Lower/Expected RandomForest bands (PromQL). ` +
        `For dates older than ~35 days, add the **History Comparison (historical / Influx)** panel too.`
    );
}
