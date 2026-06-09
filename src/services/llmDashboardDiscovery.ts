import type { McpClient } from './dashboardChunkedUpdate';
import { callMcpTool } from './mcpToolClient';
import { extractDashboardFromGetByUid } from './programmaticDashboardClone';
import { listDashboardPanels } from './panelDiscovery';
import { recordDashboardFetchFromMcpText } from './llmDashboardSnapshot';
import { inferMachineIdFromDashboardTitle } from './programmaticDashboardResolve';

/** Pre-inject compact dashboard index before LLM (one MCP fetch). */
export async function buildDashboardDiscoveryContextBlock(
    mcpClient: McpClient,
    dashboardUid: string
): Promise<string> {
    const fetch = await callMcpTool(mcpClient, 'get_dashboard_by_uid', { uid: dashboardUid });
    if (!fetch.ok) {
        return '';
    }

    recordDashboardFetchFromMcpText(dashboardUid, fetch.text);

    const extracted = extractDashboardFromGetByUid(fetch.text);
    if (!extracted?.dashboard) {
        return '';
    }

    const title = typeof extracted.dashboard.title === 'string' ? extracted.dashboard.title : dashboardUid;
    const entries = listDashboardPanels(extracted.dashboard.panels);
    const contentPanels = entries.filter((e) => String(e.panel.type ?? '') !== 'row');
    const sample = contentPanels.slice(0, 24).map((e) => `- ${e.title || '(untitled)'} (id ${e.panelId ?? '?'})`);
    const machineId = inferMachineIdFromDashboardTitle(title);

    const lines = [
        `## Dashboard index (pre-loaded for uid \`${dashboardUid}\`)`,
        `Title: **${title}** · ${contentPanels.length} content panel(s)`,
    ];
    if (machineId) {
        lines.push(
            `Machine id: **${machineId}** — Keysight/instrumentation metrics use Prometheus \`machine_metrics{machine="${machineId}", field="..."}\`.`
        );
    }
    lines.push('Sample panels:', ...sample);
    if (contentPanels.length > sample.length) {
        lines.push(`… and ${contentPanels.length - sample.length} more.`);
    }
    lines.push('Use this index; do not re-fetch unless you need full JSON for update_dashboard.');
    return lines.join('\n');
}
