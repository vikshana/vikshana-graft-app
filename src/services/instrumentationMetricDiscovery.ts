import { parseJsonFromMcpText } from './mcpToolClient';
import { callMcpTool } from './mcpToolClient';
import type { McpClient } from './dashboardChunkedUpdate';
import { listDashboardPanels, type DashboardPanelEntry } from './panelDiscovery';
import { inferMachineIdFromDashboardTitle } from './programmaticDashboardResolve';

export interface DiscoveredMetric {
    key: string;
    title: string;
    expr: string;
    datasourceType: 'prometheus' | 'influx';
    datasourceUid?: string;
}

const SKIP_METRIC_RE =
    /^(machine_metric_(?:upper|lower|expected)_bound|machine_metrics|ALERTS|go_|prometheus_|grafana_|anomaly:)/i;

function humanizeMetricName(name: string): string {
    return name
        .replace(/_/g, ' ')
        .replace(/\bpsi\b/i, ' (psi)')
        .replace(/\bC\b$/, ' °C')
        .replace(/\s+/g, ' ')
        .trim();
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

function extractPrometheusDatasource(panel: Record<string, unknown>): { uid?: string; type: string } {
    const ds = panel.datasource;
    if (ds && typeof ds === 'object') {
        const obj = ds as Record<string, unknown>;
        return {
            uid: typeof obj.uid === 'string' ? obj.uid : undefined,
            type: typeof obj.type === 'string' ? obj.type : 'prometheus',
        };
    }
    if (typeof ds === 'string') {
        return { uid: ds, type: 'prometheus' };
    }
    return { type: 'prometheus' };
}

function extractDatasourceFromTargets(panel: Record<string, unknown>): { uid?: string; type: string } | undefined {
    const targets = panel.targets;
    if (!Array.isArray(targets)) {
        return undefined;
    }
    for (const t of targets) {
        if (!t || typeof t !== 'object') {
            continue;
        }
        const target = t as Record<string, unknown>;
        if (typeof target.expr === 'string') {
            const ds = target.datasource ?? panel.datasource;
            if (ds && typeof ds === 'object') {
                const obj = ds as Record<string, unknown>;
                return {
                    uid: typeof obj.uid === 'string' ? obj.uid : undefined,
                    type: typeof obj.type === 'string' ? obj.type : 'prometheus',
                };
            }
        }
        if (typeof target.query === 'string') {
            const ds = target.datasource ?? panel.datasource;
            if (ds && typeof ds === 'object') {
                const obj = ds as Record<string, unknown>;
                return {
                    uid: typeof obj.uid === 'string' ? obj.uid : undefined,
                    type: typeof obj.type === 'string' ? obj.type : 'influxdb',
                };
            }
        }
    }
    return undefined;
}

/** Collect metric keys already shown on the dashboard (PromQL expr or Flux _field). */
export function extractMetricsFromPanels(
    panels: unknown[],
    machineId: string
): DiscoveredMetric[] {
    const entries = listDashboardPanels(panels);
    const out: DiscoveredMetric[] = [];
    const seen = new Set<string>();

    for (const entry of entries) {
        const panel = entry.panel;
        const targets = panel.targets;
        if (!Array.isArray(targets)) {
            continue;
        }
        const ds =
            extractDatasourceFromTargets(panel) ??
            extractPrometheusDatasource(panel);

        for (const t of targets) {
            if (!t || typeof t !== 'object') {
                continue;
            }
            const target = t as Record<string, unknown>;
            const expr = typeof target.expr === 'string' ? target.expr : '';
            if (expr) {
                const direct = expr.match(
                    new RegExp(`([a-zA-Z_:][a-zA-Z0-9_:]*)\\{[^}]*machine="${machineId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'i')
                );
                if (direct?.[1] && !SKIP_METRIC_RE.test(direct[1])) {
                    const key = `prom:${direct[1]}`;
                    if (!seen.has(key)) {
                        seen.add(key);
                        out.push({
                            key,
                            title: humanizeMetricName(direct[1]),
                            expr: `${direct[1]}{machine="${machineId}"}`,
                            datasourceType: 'prometheus',
                            datasourceUid: ds.uid,
                        });
                    }
                }
                const field = expr.match(/field="([^"]+)"/)?.[1];
                if (field && expr.includes('machine_metrics') && !SKIP_METRIC_RE.test(field)) {
                    const key = `field:${field}`;
                    if (!seen.has(key)) {
                        seen.add(key);
                        out.push({
                            key,
                            title: humanizeMetricName(field),
                            expr: `machine_metrics{machine="${machineId}",field="${field}"}`,
                            datasourceType: 'prometheus',
                            datasourceUid: ds.uid,
                        });
                    }
                }
            }

            const query = typeof target.query === 'string' ? target.query : '';
            const fluxField = query.match(/r\._field\s*==\s*"([^"]+)"/)?.[1];
            if (fluxField && query.includes(`r.machine == "${machineId}"`)) {
                const key = `flux:${fluxField}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    out.push({
                        key,
                        title: humanizeMetricName(fluxField),
                        expr: query,
                        datasourceType: 'influx',
                        datasourceUid: ds.uid,
                    });
                }
            }
        }
    }

    return out;
}

function shouldSkipPrometheusMetric(name: string): boolean {
    if (!name || SKIP_METRIC_RE.test(name)) {
        return true;
    }
    if (/^machine_metric_/.test(name)) {
        return true;
    }
    return false;
}

export async function discoverPrometheusMetricsForMachine(
    mcpClient: McpClient,
    machineId: string,
    datasourceUid?: string
): Promise<string[]> {
    const matchers = [`{machine="${machineId}"}`];
    const argVariants: Record<string, unknown>[] = [
        { datasourceUid, labelName: '__name__', labelMatchers: matchers },
        { datasourceUid, labelName: '__name__', matches: matchers },
        { datasourceUid, labelName: '__name__', match: matchers[0] },
        { labelName: '__name__', labelMatchers: matchers },
    ];

    for (const args of argVariants) {
        const cleaned = Object.fromEntries(Object.entries(args).filter(([, v]) => v != null));
        const result = await callMcpTool(mcpClient, 'list_prometheus_label_values', cleaned);
        if (!result.ok) {
            continue;
        }
        const names = parseStringListFromMcpText(result.text).filter((n) => !shouldSkipPrometheusMetric(n));
        if (names.length > 0) {
            return [...new Set(names)].sort((a, b) => a.localeCompare(b));
        }
    }
    return [];
}

export async function discoverInstrumentationMetrics(
    mcpClient: McpClient,
    opts: {
        panels: unknown[];
        dashboardTitle?: string;
        machineId?: string;
        prometheusDatasourceUid?: string;
        maxMetrics?: number;
    }
): Promise<{ metrics: DiscoveredMetric[]; machineId: string; prometheusNames: number }> {
    const machineId =
        opts.machineId ?? inferMachineIdFromDashboardTitle(opts.dashboardTitle) ?? '2505-200033';

    const fromPanels = extractMetricsFromPanels(opts.panels, machineId);
    const promNames = await discoverPrometheusMetricsForMachine(
        mcpClient,
        machineId,
        opts.prometheusDatasourceUid
    );

    const merged = new Map<string, DiscoveredMetric>();
    for (const m of fromPanels) {
        merged.set(m.key, m);
    }
    for (const name of promNames) {
        const key = `prom:${name}`;
        if (!merged.has(key)) {
            merged.set(key, {
                key,
                title: humanizeMetricName(name),
                expr: `${name}{machine="${machineId}"}`,
                datasourceType: 'prometheus',
                datasourceUid: opts.prometheusDatasourceUid,
            });
        }
    }

    let metrics = [...merged.values()].sort((a, b) => a.title.localeCompare(b.title));
    if (opts.maxMetrics != null && opts.maxMetrics > 0) {
        metrics = metrics.slice(0, opts.maxMetrics);
    }

    return { metrics, machineId, prometheusNames: promNames.length };
}

export function findPrometheusTemplatePanel(entries: DashboardPanelEntry[]): DashboardPanelEntry | undefined {
    return (
        entries.find(
            (e) =>
                e.panel.type === 'stat' &&
                Array.isArray(e.panel.targets) &&
                (e.panel.targets as Record<string, unknown>[]).some((t) => typeof t.expr === 'string')
        ) ??
        entries.find(
            (e) =>
                (e.panel.type === 'gauge' || e.panel.type === 'timeseries') &&
                Array.isArray(e.panel.targets) &&
                (e.panel.targets as Record<string, unknown>[]).some((t) => typeof t.expr === 'string')
        )
    );
}

export function inferUnitForMetric(title: string): string | undefined {
    const t = title.toLowerCase();
    if (t.includes('psi') || t.includes('pressure')) {
        return 'psi';
    }
    if (t.includes('temp') || t.includes('°c')) {
        return 'celsius';
    }
    if (t.includes('flow') && t.includes('min')) {
        return 'flowlpm';
    }
    if (t.includes('percent') || t.includes('level')) {
        return 'percent';
    }
    return undefined;
}
