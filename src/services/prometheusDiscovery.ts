import type { ToolExecution } from '../types/llm.types';
import { callMcpTool, parseJsonFromMcpText } from './mcpToolClient';
import type { McpClient } from './dashboardChunkedUpdate';
import { listDashboardPanels } from './panelDiscovery';
import { findPrometheusTemplatePanel } from './instrumentationMetricDiscovery';

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

function parseDatasourceList(text: string): Array<{ uid?: string; type?: string; name?: string }> {
    const parsed = parseJsonFromMcpText(text);
    if (Array.isArray(parsed)) {
        return parsed.filter((x) => x && typeof x === 'object') as Array<{
            uid?: string;
            type?: string;
            name?: string;
        }>;
    }
    return [];
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

    const template = findPrometheusTemplatePanel(entries);
    if (template) {
        const uid = prometheusUidFromPanelBlob(template.panel);
        if (uid) {
            return uid;
        }
    }

    const step: ToolExecution = { name: 'list_datasources', status: 'pending' };
    toolExecutions?.push(step);
    const list = await callMcpTool(mcpClient, 'list_datasources', {});
    if (toolExecutions?.length) {
        toolExecutions[toolExecutions.length - 1] = {
            ...step,
            status: list.ok ? 'success' : 'error',
            error: list.error,
            summary: list.summary,
        };
    }
    if (!list.ok) {
        return undefined;
    }

    const hits = parseDatasourceList(list.text);
    const preferred =
        hits.find((d) => d.type === 'prometheus' && /prometheus/i.test(d.name ?? '')) ??
        hits.find((d) => d.type === 'prometheus');
    return preferred?.uid;
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

    if (names.size === 0) {
        const queryResult = await callMcpTool(mcpClient, 'query_prometheus', {
            datasourceUid,
            expr: `{machine="${machineId}"}`,
            queryType: 'instant',
            startTime: 'now-24h',
            endTime: 'now',
        });
        if (queryResult.ok) {
            for (const n of extractMetricNamesFromPrometheusQueryText(queryResult.text)) {
                names.add(n);
            }
        }
    }

    if (names.size === 0) {
        const topicQuery = await callMcpTool(mcpClient, 'query_prometheus', {
            datasourceUid,
            expr: `{topic="${machineId}"}`,
            queryType: 'instant',
            startTime: 'now-24h',
            endTime: 'now',
        });
        if (topicQuery.ok) {
            for (const n of extractMetricNamesFromPrometheusQueryText(topicQuery.text)) {
                names.add(n);
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
