import type { ToolExecution } from '../types/llm.types';
import { callMcpTool, parseJsonFromMcpText } from './mcpToolClient';
import type { McpClient } from './dashboardChunkedUpdate';
import { listDashboardPanels } from './panelDiscovery';

export interface PrometheusLabelMatcher {
    name: string;
    value: string;
    type: '=' | '!=' | '=~' | '!~';
}

export interface PrometheusSelector {
    filters: PrometheusLabelMatcher[];
}

export function machinePrometheusSelectors(machineId: string): PrometheusSelector[] {
    return [
        { filters: [{ name: 'machine', value: machineId, type: '=' }] },
        { filters: [{ name: 'topic', value: machineId, type: '=' }] },
    ];
}

/** Selectors for `machine_metrics` series (PowerTech ML exporter uses `field` label). */
export function machineMetricsFieldSelectors(machineId: string): PrometheusSelector[] {
    const base = { name: '__name__', value: 'machine_metrics', type: '=' as const };
    return [
        { filters: [base, { name: 'machine', value: machineId, type: '=' }] },
        { filters: [base, { name: 'topic', value: machineId, type: '=' }] },
    ];
}

function parseDatasourceList(text: string): Array<{ uid?: string; type?: string; name?: string }> {
    const parsed = parseJsonFromMcpText(text);
    if (Array.isArray(parsed)) {
        return parsed.filter((x) => x && typeof x === 'object') as Array<{
            uid?: string;
            type?: string;
            name?: string;
        }>;
    }
    if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        for (const key of ['datasources', 'data', 'items', 'results']) {
            const nested = obj[key];
            if (Array.isArray(nested)) {
                return nested.filter((x) => x && typeof x === 'object') as Array<{
                    uid?: string;
                    type?: string;
                    name?: string;
                }>;
            }
        }
        if (typeof obj.uid === 'string' && typeof obj.type === 'string') {
            return [obj as { uid?: string; type?: string; name?: string }];
        }
    }
    return [];
}

async function tryDatasourceByName(
    mcpClient: McpClient,
    name: string,
    toolExecutions?: ToolExecution[]
): Promise<string | undefined> {
    const step: ToolExecution = { name: 'get_datasource_by_name', status: 'pending' };
    toolExecutions?.push(step);
    const result = await callMcpTool(mcpClient, 'get_datasource_by_name', { name });
    if (toolExecutions?.length) {
        toolExecutions[toolExecutions.length - 1] = {
            ...step,
            status: result.ok ? 'success' : 'error',
            error: result.error,
            summary: result.summary,
        };
    }
    if (!result.ok) {
        return undefined;
    }
    const parsed = parseJsonFromMcpText(result.text);
    if (parsed && typeof parsed === 'object') {
        const uid = (parsed as { uid?: string }).uid;
        if (uid) {
            return uid;
        }
    }
    const uidMatch = result.text.match(/"uid"\s*:\s*"([^"]+)"/);
    return uidMatch?.[1];
}

function prometheusUidFromPanelBlob(panel: Record<string, unknown>): string | undefined {
    const checkDs = (ds: unknown): string | undefined => {
        if (ds && typeof ds === 'object') {
            const obj = ds as { uid?: string; type?: string };
            if (obj.type === 'prometheus' && typeof obj.uid === 'string') {
                return obj.uid;
            }
        }
        return undefined;
    };

    const top = checkDs(panel.datasource);
    if (top) {
        return top;
    }

    const targets = panel.targets;
    if (!Array.isArray(targets)) {
        return undefined;
    }
    for (const t of targets) {
        if (!t || typeof t !== 'object') {
            continue;
        }
        const target = t as Record<string, unknown>;
        if (typeof target.expr !== 'string') {
            continue;
        }
        const uid = checkDs(target.datasource ?? panel.datasource);
        if (uid) {
            return uid;
        }
    }
    return undefined;
}

function influxUidFromPanelBlob(panel: Record<string, unknown>): string | undefined {
    const checkDs = (ds: unknown): string | undefined => {
        if (ds && typeof ds === 'object') {
            const obj = ds as { uid?: string; type?: string };
            if (
                typeof obj.uid === 'string' &&
                obj.uid &&
                (/influx/i.test(obj.type ?? '') || !obj.type)
            ) {
                // Prefer typed influx; uid-only refs are accepted when the panel has Flux queries.
                if (/influx/i.test(obj.type ?? '')) {
                    return obj.uid;
                }
            }
        }
        return undefined;
    };

    const top = checkDs(panel.datasource);
    if (top) {
        return top;
    }

    const targets = panel.targets;
    if (!Array.isArray(targets)) {
        return undefined;
    }
    for (const t of targets) {
        if (!t || typeof t !== 'object') {
            continue;
        }
        const target = t as Record<string, unknown>;
        const query = typeof target.query === 'string' ? target.query : '';
        const isFlux = /\bfrom\s*\(\s*bucket:/i.test(query);
        const ds = target.datasource ?? panel.datasource;
        if (ds && typeof ds === 'object') {
            const obj = ds as { uid?: string; type?: string };
            if (typeof obj.uid === 'string' && obj.uid) {
                if (/influx/i.test(obj.type ?? '') || (isFlux && !obj.type)) {
                    return obj.uid;
                }
                // Flux on a mislabeled datasource (seen in fixtures) — still use its uid.
                if (isFlux && obj.uid) {
                    return obj.uid;
                }
            }
        } else if (typeof ds === 'string' && ds && isFlux) {
            return ds;
        }
    }
    return undefined;
}

/** Resolve Influx datasource UID from dashboard Flux panels or list_datasources (no hard-coded uid). */
export async function resolveInfluxDatasourceUid(
    mcpClient: McpClient,
    panels: unknown,
    toolExecutions?: ToolExecution[]
): Promise<string | undefined> {
    const panelList = Array.isArray(panels) ? panels : [];
    const entries = listDashboardPanels(panelList);
    for (const entry of entries) {
        const uid = influxUidFromPanelBlob(entry.panel);
        if (uid) {
            return uid;
        }
    }

    const listStep: ToolExecution = { name: 'list_datasources', status: 'pending' };
    toolExecutions?.push(listStep);
    const list = await callMcpTool(mcpClient, 'list_datasources', {});
    if (toolExecutions?.length) {
        toolExecutions[toolExecutions.length - 1] = {
            ...listStep,
            status: list.ok ? 'success' : 'error',
            error: list.error,
            summary: list.summary,
        };
    }
    if (list.ok) {
        const hits = parseDatasourceList(list.text);
        const preferred =
            hits.find((d) => /influx/i.test(d.type ?? '') && /influx/i.test(d.name ?? '')) ??
            hits.find((d) => /influx/i.test(d.type ?? ''));
        if (preferred?.uid) {
            return preferred.uid;
        }
    }

    for (const name of ['InfluxDB', 'Influx', 'influxdb', 'influx']) {
        const uid = await tryDatasourceByName(mcpClient, name, toolExecutions);
        if (uid) {
            return uid;
        }
    }

    return undefined;
}

/** Names sandbox/live Grafana may use. `list_datasources` is preferred; these are get_datasource_by_name fallbacks. */
export const PROMETHEUS_DATASOURCE_LOOKUP_NAMES = [
    'Prometheus',
    'prometheus',
    'VictoriaMetrics',
    'Mimir',
    'ElectraMet Prometheus',
    'Prometheus-ElectraMet',
] as const;

/** Resolve Prometheus datasource UID from dashboard panels or list_datasources. */
export async function resolvePrometheusDatasourceUid(
    mcpClient: McpClient,
    panels: unknown[],
    toolExecutions?: ToolExecution[]
): Promise<string | undefined> {
    const entries = listDashboardPanels(panels);
    for (const entry of entries) {
        const uid = prometheusUidFromPanelBlob(entry.panel);
        if (uid) {
            return uid;
        }
    }

    const listStep: ToolExecution = { name: 'list_datasources', status: 'pending' };
    toolExecutions?.push(listStep);
    const list = await callMcpTool(mcpClient, 'list_datasources', {});
    if (toolExecutions?.length) {
        toolExecutions[toolExecutions.length - 1] = {
            ...listStep,
            status: list.ok ? 'success' : 'error',
            error: list.error,
            summary: list.summary,
        };
    }
    if (list.ok) {
        const hits = parseDatasourceList(list.text);
        const preferred =
            hits.find((d) => d.type === 'prometheus' && /prometheus/i.test(d.name ?? '')) ??
            hits.find((d) => d.type === 'prometheus');
        if (preferred?.uid) {
            return preferred.uid;
        }
    }

    for (const name of PROMETHEUS_DATASOURCE_LOOKUP_NAMES) {
        const uid = await tryDatasourceByName(mcpClient, name, toolExecutions);
        if (uid) {
            return uid;
        }
    }

    return undefined;
}

export function extractMetricNamesFromPrometheusQueryText(text: string): string[] {
    const names = new Set<string>();
    for (const m of text.matchAll(/"__name__"\s*:\s*"([^"]+)"/g)) {
        if (m[1]) {
            names.add(m[1]);
        }
    }
    for (const m of text.matchAll(/__name__="([^"]+)"/g)) {
        if (m[1]) {
            names.add(m[1]);
        }
    }
    return [...names];
}

export async function discoverPrometheusMetricNamesForMachine(
    mcpClient: McpClient,
    machineId: string,
    datasourceUid: string,
    limit = 500
): Promise<string[]> {
    const names = new Set<string>();

    for (const selector of machinePrometheusSelectors(machineId)) {
        const labelResult = await callMcpTool(mcpClient, 'list_prometheus_label_values', {
            datasourceUid,
            labelName: '__name__',
            matches: [selector],
            limit,
        });
        if (labelResult.ok) {
            for (const n of parseStringListFromMcpText(labelResult.text)) {
                names.add(n);
            }
        }
    }

    const instantQueries = [
        `{machine="${machineId}"}`,
        `{topic="${machineId}"}`,
        `{machine="${machineId}",topic="${machineId}"}`,
    ];
    for (const expr of instantQueries) {
        const queryResult = await callMcpTool(mcpClient, 'query_prometheus', {
            datasourceUid,
            expr,
            queryType: 'instant',
            endTime: 'now',
        });
        if (queryResult.ok) {
            for (const n of extractMetricNamesFromPrometheusQueryText(queryResult.text)) {
                names.add(n);
            }
        }
    }

    if (names.size === 0) {
        const metricNames = await callMcpTool(mcpClient, 'list_prometheus_metric_names', {
            datasourceUid,
            regex: '.*',
            limit: Math.min(limit, 200),
        });
        if (metricNames.ok) {
            let probed = 0;
            for (const candidate of parseStringListFromMcpText(metricNames.text)) {
                if (names.size >= limit || probed >= 80) {
                    break;
                }
                probed++;
                const probe = await callMcpTool(mcpClient, 'query_prometheus', {
                    datasourceUid,
                    expr: `${candidate}{machine="${machineId}"}`,
                    queryType: 'instant',
                    endTime: 'now',
                });
                if (probe.ok && extractMetricNamesFromPrometheusQueryText(probe.text).includes(candidate)) {
                    names.add(candidate);
                }
            }
        }
    }

    return [...names].sort((a, b) => a.localeCompare(b));
}

function shouldSkipMachineMetricField(name: string): boolean {
    if (!name || SKIP_MACHINE_FIELD_RE.test(name)) {
        return true;
    }
    return false;
}

const SKIP_MACHINE_FIELD_RE =
    /^(machine_metric_(?:upper|lower|expected)_bound|ALERTS|go_|prometheus_|grafana_)/i;

export async function discoverPrometheusFieldNamesForMachine(
    mcpClient: McpClient,
    machineId: string,
    datasourceUid: string,
    limit = 500
): Promise<string[]> {
    const names = new Set<string>();

    for (const selector of machineMetricsFieldSelectors(machineId)) {
        const labelResult = await callMcpTool(mcpClient, 'list_prometheus_label_values', {
            datasourceUid,
            labelName: 'field',
            matches: [selector],
            limit,
        });
        if (labelResult.ok) {
            for (const n of parseStringListFromMcpText(labelResult.text)) {
                if (!shouldSkipMachineMetricField(n)) {
                    names.add(n);
                }
            }
        }
    }

    if (names.size === 0) {
        const queryResult = await callMcpTool(mcpClient, 'query_prometheus', {
            datasourceUid,
            expr: `machine_metrics{machine="${machineId}"}`,
            queryType: 'instant',
            endTime: 'now',
        });
        if (queryResult.ok) {
            for (const m of queryResult.text.matchAll(/"field"\s*:\s*"([^"]+)"/g)) {
                if (m[1] && !shouldSkipMachineMetricField(m[1])) {
                    names.add(m[1]);
                }
            }
        }
    }

    return [...names].sort((a, b) => a.localeCompare(b));
}

function parseStringListFromMcpText(text: string): string[] {
    const parsed = parseJsonFromMcpText(text);
    if (Array.isArray(parsed)) {
        return parsed.filter((x): x is string => typeof x === 'string');
    }
    const jsonArray = text.match(/\[[\s\S]*\]/);
    if (jsonArray) {
        try {
            const arr = JSON.parse(jsonArray[0]) as unknown;
            if (Array.isArray(arr)) {
                return arr.filter((x): x is string => typeof x === 'string');
            }
        } catch {
            /* ignore */
        }
    }
    return text
        .split('\n')
        .map((l) => l.trim().replace(/^["']|["'],?$/g, ''))
        .filter((l) => l.length > 0 && !l.startsWith('{'));
}
