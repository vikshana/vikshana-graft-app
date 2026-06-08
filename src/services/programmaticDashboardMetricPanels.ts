import type { ToolExecution } from '../types/llm.types';
import { extractDashboardFromGetByUid } from './programmaticDashboardClone';
import { callMcpTool } from './mcpToolClient';
import type { McpClient } from './dashboardChunkedUpdate';
import { stampDashboardForOverwrite } from './fluxQueryFix';
import { normalizeUpdateDashboardArgs } from './updateDashboardArgs';
import { applyBestPracticeDashboardLayout } from './dashboardLayoutBestPractices';
import { listDashboardPanels, type DashboardPanelEntry } from './panelDiscovery';
import {
    discoverInstrumentationMetrics,
    findPrometheusTemplatePanel,
    inferUnitForMetric,
    type DiscoveredMetric,
} from './instrumentationMetricDiscovery';
import { resolveDashboardUid } from './programmaticDashboardResolve';
import type { DashboardMetricPanelsRequest } from './dashboardMetricPanelsParse';
import { formatDashboardMetricPanelsExamplePrompt } from './dashboardMetricPanelsParse';

type PanelRecord = Record<string, unknown>;

export interface DashboardMetricPanelsResult {
    ok: boolean;
    error?: string;
    toolExecutions: ToolExecution[];
    dashboardUid?: string;
    dashboardTitle?: string;
    version?: number;
    metricsDiscovered?: number;
    panelsAdded?: number;
    panelsSkipped?: number;
    machineId?: string;
    prometheusNames?: number;
    prometheusFields?: number;
    prometheusDatasourceUid?: string;
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

function normalizeExpr(expr: string): string {
    return expr.replace(/\s+/g, ' ').trim();
}

function panelAlreadyShowsMetric(entries: DashboardPanelEntry[], metric: DiscoveredMetric): boolean {
    const want = normalizeExpr(metric.expr);
    const metricName = metric.key.replace(/^(prom|flux|field):/, '');

    for (const entry of entries) {
        const panelType = String(entry.panel.type ?? '');
        const targets = entry.panel.targets;
        if (!Array.isArray(targets)) {
            continue;
        }
        for (const t of targets) {
            if (!t || typeof t !== 'object') {
                continue;
            }
            const target = t as Record<string, unknown>;
            const expr = typeof target.expr === 'string' ? normalizeExpr(target.expr) : '';
            const query = typeof target.query === 'string' ? normalizeExpr(target.query) : '';
            if (expr && expr === want) {
                return true;
            }
            if (query && query === want) {
                return true;
            }
            if (panelType !== 'stat' && panelType !== 'gauge') {
                continue;
            }
            if (metric.datasourceType === 'prometheus' && expr) {
                if (new RegExp(`\\b${metricName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(expr)) {
                    return true;
                }
            }
            if (metric.datasourceType === 'influx' && query) {
                if (query.includes(`r._field == "${metricName}"`)) {
                    return true;
                }
            }
        }
    }
    return false;
}

function buildMetricPanel(
    id: number,
    metric: DiscoveredMetric,
    template: PanelRecord | undefined,
    gridPos: { x: number; y: number; w: number; h: number }
): PanelRecord {
    if (metric.datasourceType === 'influx') {
        const dsUid = metric.datasourceUid ?? (template?.datasource as { uid?: string } | undefined)?.uid;
        const datasource = dsUid ? { type: 'influxdb', uid: dsUid } : { type: 'influxdb' };
        return {
            id,
            type: 'stat',
            title: metric.title,
            gridPos,
            datasource,
            fieldConfig: {
                defaults: {
                    color: { mode: 'thresholds' },
                    unit: inferUnitForMetric(metric.title),
                    thresholds: { mode: 'absolute', steps: [{ color: 'green', value: null }] },
                },
                overrides: [],
            },
            options: { reduceOptions: { values: false, calcs: ['lastNotNull'] } },
            targets: [
                {
                    refId: 'A',
                    datasource,
                    query: metric.expr,
                    rawQuery: true,
                },
            ],
        };
    }

    return buildPrometheusStatPanel(id, metric, template, gridPos);
}

function buildPrometheusStatPanel(
    id: number,
    metric: DiscoveredMetric,
    template: PanelRecord | undefined,
    gridPos: { x: number; y: number; w: number; h: number }
): PanelRecord {
    const dsUid = metric.datasourceUid ?? (template?.datasource as { uid?: string } | undefined)?.uid;
    const datasource = dsUid ? { type: 'prometheus', uid: dsUid } : { type: 'prometheus' };
    const unit = inferUnitForMetric(metric.title);
    const base = template ? (JSON.parse(JSON.stringify(template)) as PanelRecord) : {};

    const panel: PanelRecord = {
        ...base,
        id,
        type: 'stat',
        title: metric.title,
        gridPos,
        datasource,
        fieldConfig: {
            defaults: {
                ...(base.fieldConfig as { defaults?: Record<string, unknown> } | undefined)?.defaults,
                color: { mode: 'thresholds' },
                unit,
                thresholds: {
                    mode: 'absolute',
                    steps: [{ color: 'green', value: null }],
                },
            },
            overrides: [],
        },
        options: {
            reduceOptions: { values: false, calcs: ['lastNotNull'] },
            ...(base.options as Record<string, unknown> | undefined),
        },
        targets: [
            {
                refId: 'A',
                datasource,
                expr: metric.expr,
                legendFormat: metric.title,
            },
        ],
    };
    delete panel.timeFrom;
    delete panel.timeTo;
    return panel;
}

function layoutNewStatPanels(
    existingPanels: PanelRecord[],
    newPanels: PanelRecord[],
    titleLabel?: string,
    dashboardTitle?: string
): PanelRecord[] {
    const combined = [...existingPanels, ...newPanels];
    return applyBestPracticeDashboardLayout(combined, {
        dashboardTitle,
        titleLabel,
    }).panels;
}

export async function runProgrammaticDashboardMetricPanels(
    mcpClient: McpClient,
    request: DashboardMetricPanelsRequest
): Promise<DashboardMetricPanelsResult> {
    const toolExecutions: ToolExecution[] = [];
    const resolved = await resolveDashboardUid(mcpClient, request, toolExecutions);
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
    const topLevel = Array.isArray(baseline.panels) ? (baseline.panels as PanelRecord[]) : [];
    const entries = listDashboardPanels(topLevel);
    const templateEntry = findPrometheusTemplatePanel(entries);
    const template = templateEntry?.panel;

    const discovery = await discoverInstrumentationMetrics(mcpClient, {
        panels: topLevel,
        dashboardTitle,
        machineId: request.machineId,
        maxMetrics: request.maxPanels ?? 50,
        toolExecutions,
    });

    if (discovery.metrics.length === 0) {
        return {
            ok: false,
            error:
                discovery.discoveryError ??
                `No metrics discovered for machine **${discovery.machineId}** on dashboard \`${resolved.uid}\`.`,
            toolExecutions,
            dashboardUid: resolved.uid,
            dashboardTitle,
            machineId: discovery.machineId,
        };
    }

    let nextId = maxPanelId(entries) + 1;
    const newPanels: PanelRecord[] = [];
    let skipped = 0;

    for (const metric of discovery.metrics) {
        if (panelAlreadyShowsMetric(entries, metric)) {
            skipped++;
            continue;
        }
        newPanels.push(buildMetricPanel(nextId++, metric, template, { x: 0, y: 0, w: 4, h: 6 }));
    }

    if (newPanels.length === 0) {
        return {
            ok: true,
            toolExecutions,
            dashboardUid: resolved.uid,
            dashboardTitle,
            metricsDiscovered: discovery.metrics.length,
            panelsAdded: 0,
            panelsSkipped: skipped,
            machineId: discovery.machineId,
            prometheusNames: discovery.prometheusNames,
            prometheusFields: discovery.prometheusFields,
            prometheusDatasourceUid: discovery.prometheusDatasourceUid,
            error: undefined,
        };
    }

    const proposed = JSON.parse(JSON.stringify(baseline)) as Record<string, unknown>;
    proposed.panels = layoutNewStatPanels(
        topLevel,
        newPanels,
        request.titleLabel,
        dashboardTitle
    );

    const saveStep = pendingTool('update_dashboard');
    toolExecutions.push(saveStep);
    const savePayload = normalizeUpdateDashboardArgs({
        dashboard: stampDashboardForOverwrite(baseline, proposed),
        overwrite: true,
    });
    const save = await callMcpTool(mcpClient, 'update_dashboard', savePayload);
    toolExecutions[toolExecutions.length - 1] = finishTool(saveStep, save);
    if (!save.ok) {
        return {
            ok: false,
            error: save.error ?? 'update_dashboard failed',
            toolExecutions,
            dashboardUid: resolved.uid,
            dashboardTitle,
            metricsDiscovered: discovery.metrics.length,
            machineId: discovery.machineId,
        };
    }

    const versionMatch = save.text.match(/"version"\s*:\s*(\d+)/);
    const version = versionMatch ? parseInt(versionMatch[1], 10) : undefined;

    return {
        ok: true,
        toolExecutions,
        dashboardUid: resolved.uid,
        dashboardTitle,
        version,
        metricsDiscovered: discovery.metrics.length,
        panelsAdded: newPanels.length,
        panelsSkipped: skipped,
        machineId: discovery.machineId,
        prometheusNames: discovery.prometheusNames,
        prometheusFields: discovery.prometheusFields,
        prometheusDatasourceUid: discovery.prometheusDatasourceUid,
    };
}

function formatPrometheusDiscoveryLine(result: DashboardMetricPanelsResult): string {
    const names = result.prometheusNames ?? 0;
    const fields = result.prometheusFields ?? 0;
    const parts: string[] = [];
    if (fields > 0) {
        parts.push(`${fields} \`machine_metrics\` field(s)`);
    }
    if (names > 0) {
        parts.push(`${names} metric name(s)`);
    }
    if (parts.length === 0) {
        return '0 from Prometheus API';
    }
    return parts.join(', ') + ' from Prometheus API';
}

export function formatDashboardMetricPanelsReply(
    result: DashboardMetricPanelsResult,
    buildNumber: string | number
): string {
    if (!result.ok) {
        return (
            `### Metric panels — failed (build ${buildNumber})\n\n` +
            `${result.error ?? 'Unknown error'}\n\n` +
            `Example:\n\n\`\`\`text\n${formatDashboardMetricPanelsExamplePrompt()}\n\`\`\``
        );
    }
    if ((result.panelsAdded ?? 0) === 0) {
        return (
            `### Metric panels — no new panels (build ${buildNumber})\n\n` +
            `- Dashboard: \`${result.dashboardUid}\`\n` +
            `- Machine: **${result.machineId ?? '?'}**\n` +
            `- Prometheus datasource: \`${result.prometheusDatasourceUid ?? '?'}\`\n` +
            `- Discovered **${result.metricsDiscovered ?? 0}** metric(s) (${formatPrometheusDiscoveryLine(result)}); existing stat/gauge panels already cover them (${result.panelsSkipped ?? 0} skipped).\n` +
            `- If you expected more metrics, verify Prometheus has series with \`machine="${result.machineId ?? '2505-200033'}"\`.\n\n` +
            `Hard-refresh the dashboard (**Cmd+Shift+R**).`
        );
    }
    return (
        `### Metric panels — saved (build ${buildNumber})\n\n` +
        `- Dashboard: \`${result.dashboardUid}\` · version **${result.version ?? '?'}**\n` +
        `- Machine: **${result.machineId ?? '?'}**\n` +
        `- Prometheus datasource: \`${result.prometheusDatasourceUid ?? '?'}\`\n` +
        `- Discovered **${result.metricsDiscovered ?? 0}** metric(s) (${formatPrometheusDiscoveryLine(result)})\n` +
        `- Added **${result.panelsAdded ?? 0}** stat panel(s)` +
        `${result.panelsSkipped ? ` (${result.panelsSkipped} already present)` : ''}\n` +
        `- Layout: title row → KPI stat grid → trends/overview (PowerTech instrumentation)\n\n` +
        `Hard-refresh the dashboard (**Cmd+Shift+R**).`
    );
}
