import { llm } from '@grafana/llm';
import type { ToolExecution } from '../../types/llm.types';
import type { PlanStep, SpecialistResult, DataFindings } from './types';
import { TOOL_CATEGORIES } from '../toolFilter';

const SETTINGS_PATH = '/plugins/vikshana-graft-app';

/** findLastIndex polyfill — Array.prototype.findLastIndex requires ES2023 */
function findLastIndex<T>(arr: T[], predicate: (item: T) => boolean): number {
    for (let i = arr.length - 1; i >= 0; i--) {
        if (predicate(arr[i])) { return i; }
    }
    return -1;
}

/**
 * Tools available to the dashboard agent.
 * Explicitly limited to dashboards + datasources — it never queries data directly.
 */
const DASHBOARD_TOOL_CATEGORIES = ['dashboards', 'datasources'];

function scopeDashboardTools(allTools: any[]): any[] {
    const allowed = new Set<string>();
    for (const cat of DASHBOARD_TOOL_CATEGORIES) {
        const catKey = cat as keyof typeof TOOL_CATEGORIES;
        if (TOOL_CATEGORIES[catKey]) {
            for (const tool of TOOL_CATEGORIES[catKey]) {
                allowed.add(tool);
            }
        }
    }
    return allTools.filter(t => allowed.has(t.function?.name));
}

/**
 * Formats DataFindings into a clear, structured block for the dashboard agent's
 * system prompt. This is the primary input it uses to build panel queries.
 */
function formatFindingsForPrompt(dataFindings: DataFindings): string {
    const sections: string[] = [];

    if (dataFindings.loki) {
        const f = dataFindings.loki;
        const dsJson = `{"type": "loki", "uid": "${f.datasourceUid}"}`;
        sections.push(`## Loki Data Source
Datasource UID: ${f.datasourceUid}
Datasource name: ${f.datasourceName}
Datasource JSON (copy exactly into every Loki panel target): ${dsJson}

Validated queries — for each query, copy BOTH the expr AND the datasource JSON into the panel target:
${f.validatedQueries.map((q, i) =>
`${i + 1}. Description: ${q.description}
   LogQL expr: ${q.logql}
   Datasource JSON: ${dsJson}`
).join('\n')}`);
    }

    if (dataFindings.prometheus) {
        const f = dataFindings.prometheus;
        const dsJson = `{"type": "prometheus", "uid": "${f.datasourceUid}"}`;
        sections.push(`## Prometheus Data Source
Datasource UID: ${f.datasourceUid}
Datasource name: ${f.datasourceName}
Datasource JSON (copy exactly into every Prometheus panel target): ${dsJson}

Validated queries — for each query, copy BOTH the expr AND the datasource JSON into the panel target:
${f.validatedQueries.map((q, i) =>
`${i + 1}. Description: ${q.description}
   PromQL expr: ${q.promql}
   Datasource JSON: ${dsJson}`
).join('\n')}`);
    }

    return sections.join('\n\n');
}

/**
 * System prompt for the dashboard construction agent.
 * Uses Model.LARGE for robust structural reasoning over dashboard JSON.
 */
function buildDashboardSystemPrompt(
    stepDescription: string,
    dataFindings: DataFindings,
    context: string
): string {
    const findingsBlock = formatFindingsForPrompt(dataFindings);
    const hasFindings = findingsBlock.length > 0;
    // Findings exist but every query was filtered out (none returned data in the
    // specialist's validation run). Treat the same as no findings — the dashboard
    // agent must discover the datasource and write only queries it can verify.
    const hasValidatedQueries =
        hasFindings &&
        ((dataFindings.loki?.validatedQueries?.length ?? 0) > 0 ||
            (dataFindings.prometheus?.validatedQueries?.length ?? 0) > 0);

    return `You are a dashboard construction agent for Graft, an AI assistant embedded in Grafana.
Your task: ${stepDescription}

You have access to dashboard and datasource tools ONLY. You do NOT have query tools.
Do not attempt to call query_loki_logs, query_prometheus, or any list_loki/list_prometheus tools.
All queries have been pre-validated by upstream agents — use them exactly as provided.

${hasValidatedQueries ? `## Pre-validated data from upstream agents

${findingsBlock}

These queries have already been confirmed to return data. Copy them verbatim into panel targets.
Do NOT modify, paraphrase, or reconstruct them.` : `## No upstream data findings were provided

You have NO pre-validated queries. You MUST determine the correct datasource yourself before
writing any panel — do not guess a UID and do not reuse a datasource of the wrong type.

Mandatory steps before building data panels:
1. Call list_datasources to see the available datasources and their types.
2. Select the datasource by TYPE according to the query language you will write:
   - Log panels / LogQL ({} stream selectors) → a datasource of type "loki".
   - Metric panels / PromQL (rate(), sum(), metric names) → a datasource of type "prometheus".
3. Use that datasource's exact uid and type in every target: { "type": "<loki|prometheus>", "uid": "<uid>" }.

NEVER attach a LogQL query to a prometheus datasource, and NEVER attach a PromQL query to a loki
datasource — that is the single most common cause of an empty "No data" dashboard.`}

## Dashboard construction process (follow this order exactly)

Step 1 — Create an empty dashboard skeleton:
Call update_dashboard with:
{
  "dashboard": {
    "title": "<descriptive title>",
    "uid": "",
    "id": null,
    "panels": [],
    "schemaVersion": 38,
    "time": { "from": "now-1h", "to": "now" },
    "timepicker": {},
    "refresh": "30s",
    "tags": [],
    "templating": { "list": [] },
    "annotations": { "list": [] }
  },
  "folderId": 0,
  "overwrite": false
}

Step 2 — Get the assigned UID:
Call get_dashboard_by_uid with the uid returned by update_dashboard.
IMPORTANT: as soon as you have the UID, note it down — you will include it in your final response
as a markdown link: [Open dashboard](/d/{uid}). Do this even if subsequent steps fail.

Step 3 — Add all panels in a single update:
Build the complete panels array (one object per validated query), then call update_dashboard ONCE
with the full dashboard JSON including all panels. Do NOT call get_dashboard_by_uid before each
panel — build the entire panels array first, then write it in one call.

Step 4 — Verify:
Call get_dashboard_by_uid one final time. Confirm the panel count matches the number of panels
you wrote. If the count is wrong, note the discrepancy in your summary.

## Panel construction rules

- datasource field in each target: copy the EXACT "Datasource JSON" shown next to each query above.
  Do not look up datasource UIDs yourself — they are already provided for each query.
- CRITICAL: LogQL expressions MUST use a datasource of type "loki". PromQL expressions MUST use a
  datasource of type "prometheus". NEVER use a prometheus datasource for a LogQL query, and NEVER
  use a loki datasource for a PromQL query. If you are unsure, check the query language:
  LogQL uses {} stream selectors. PromQL uses metric names and functions like rate(), sum(), etc.
- Use the EXACT expr values from the validated queries above — copy them character-for-character.
- Panel types: "logs" for log panels, "timeseries" for time-series metrics, "stat" for single values, "bargauge" for bar charts.
- Each panel must have: id (sequential integer), title, type, gridPos, targets array.
- gridPos: use { "h": 8, "w": 12, "x": 0, "y": 0 } for the first panel and increment x/y to tile panels without overlap.
- For Loki log panels: set options.dedupStrategy = "none", options.showTime = true.
- For Loki stat/metric panels: use a metric query type rather than log type.
- legendFormat (required on every target):
  - For Loki queries: inspect the LogQL expression for label matchers (e.g. {job="api", level="error"}).
    Use the most meaningful label(s) as the legend, e.g. "{{job}} - {{level}}".
    If the query aggregates across all streams with no specific label, use a descriptive static string like "Log rate".
    If there are multiple targets in the same panel each returning different data, use labels that distinguish them — never leave all targets with the same legendFormat string.
  - For Prometheus queries: use label names from the PromQL expression, e.g. "{{job}}" or "{{instance}} {{job}}".
    If the query produces a single scalar result, use a descriptive static string.
  - Never omit legendFormat. Never set it to an empty string or the default "{{__name__}}".

## When you are done

After Step 4 (final get_dashboard_by_uid), call get_dashboard_panel_queries with the dashboard UID.
Inspect each panel's datasource type against its query expression and FIX any mismatch before finishing:
- If a panel uses a "prometheus" datasource but the expr is LogQL ({} stream selectors, |= filters),
  the panel is broken. Repoint it to a "loki" datasource (find one via list_datasources if needed)
  and call update_dashboard again with the corrected target.
- If a panel uses a "loki" datasource but the expr is PromQL (metric names, rate(), sum()),
  repoint it to a "prometheus" datasource and call update_dashboard again.
- Re-run get_dashboard_panel_queries after corrections to confirm no mismatches remain.
Do NOT finish while any panel's datasource type contradicts its query language.

Respond with a summary including:
- Dashboard title and a markdown link: [Open dashboard](/d/{uid})
- List of panels added with their titles and the queries used
- Any datasource mismatches you detected AND how you corrected them
- Any panels that could not be created and why

${context ? `## Current Grafana context\n${context}` : ''}`;
}

/**
 * Purpose-built dashboard creation/editing agent.
 *
 * Differences from the generic specialist:
 * - Uses Model.LARGE for robust dashboard JSON construction
 * - Tool scope limited to dashboards + datasources (never queries data directly)
 * - Receives pre-validated queries from upstream data specialists via DataFindings
 * - Follows a structured multi-step construction process (skeleton → get UID → add panels)
 * - Dashboard JSON results are never compressed (required for incremental panel addition)
 */
export async function runDashboardAgent(
    step: PlanStep,
    userMessage: string,
    context: string,
    dataFindings: DataFindings,
    allTools: any[],
    mcpClient: any,
    maxIterations: number,
    signal: AbortSignal,
    onUpdate: (stepId: string, toolExecutions: ToolExecution[]) => void
): Promise<SpecialistResult> {
    const scopedTools = scopeDashboardTools(allTools);
    const systemPrompt = buildDashboardSystemPrompt(step.description, dataFindings, context);

    const llmMessages: any[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
    ];

    const toolExecutions: ToolExecution[] = [];
    let fullContent = '';
    let iteration = 0;

    // Dashboard JSON results must never be compressed — the agent needs the full
    // panel array to append new panels correctly in each iteration.
    const NO_COMPRESS = new Set([
        'get_dashboard_by_uid',
        'get_dashboard_panel_queries',
        'get_dashboard_property',
        'get_dashboard_summary',
        'update_dashboard',
    ]);

    try {
        let response = await llm.chatCompletions({
            model: llm.Model.LARGE,
            messages: llmMessages,
            tools: scopedTools.length > 0 ? scopedTools : undefined,
        } as any);

        let toolCalls = response.choices?.[0]?.message?.tool_calls ?? [];
        fullContent = response.choices?.[0]?.message?.content ?? '';

        while (toolCalls.length > 0 && iteration < maxIterations) {
            if (signal.aborted) {
                throw new Error('Aborted');
            }

            iteration++;

            llmMessages.push({
                role: 'assistant',
                content: fullContent,
                tool_calls: toolCalls,
            });

            for (const toolCall of toolCalls) {
                if (signal.aborted) {
                    throw new Error('Aborted');
                }

                toolExecutions.push({ name: toolCall.function.name, status: 'pending' });
                onUpdate(step.id, toolExecutions.map(t => ({ ...t })));

                let rawResult = '';
                try {
                    if (!mcpClient) {
                        throw new Error('MCP client not available');
                    }
                    const args = JSON.parse(toolCall.function.arguments);
                    const result = await mcpClient.callTool({ name: toolCall.function.name, arguments: args });
                    rawResult = JSON.stringify(result.content);

                    llmMessages.push({
                        role: 'tool',
                        content: rawResult,
                        tool_call_id: toolCall.id,
                    });

                    const idx = findLastIndex(
                        toolExecutions,
                        (t: ToolExecution) => t.name === toolCall.function.name && t.status === 'pending'
                    );
                    if (idx !== -1) { toolExecutions[idx].status = 'success'; }
                } catch (err: any) {
                    rawResult = `Error: ${err.message}`;
                    llmMessages.push({
                        role: 'tool',
                        content: rawResult,
                        tool_call_id: toolCall.id,
                    });

                    const idx = findLastIndex(
                        toolExecutions,
                        (t: ToolExecution) => t.name === toolCall.function.name && t.status === 'pending'
                    );
                    if (idx !== -1) {
                        toolExecutions[idx].status = 'error';
                        toolExecutions[idx].error = err.message;
                    }
                }

                onUpdate(step.id, toolExecutions.map(t => ({ ...t })));
            }

            // Compress only non-dashboard tool results (list_datasources etc.)
            // Dashboard JSON is preserved verbatim for incremental panel construction.
            for (const toolCall of toolCalls) {
                if (NO_COMPRESS.has(toolCall.function.name)) { continue; }
                const msgIdx = findLastIndex(
                    llmMessages,
                    (m: any) => m.role === 'tool' && m.tool_call_id === toolCall.id
                );
                if (msgIdx !== -1) {
                    const original = llmMessages[msgIdx].content;
                    const preview = original.length > 300 ? original.slice(0, 300) + '...' : original;
                    llmMessages[msgIdx] = {
                        ...llmMessages[msgIdx],
                        content: `[${toolCall.function.name} result processed — summary: ${preview}]`,
                    };
                }
            }

            if (signal.aborted) {
                throw new Error('Aborted');
            }

            response = await llm.chatCompletions({
                model: llm.Model.LARGE,
                messages: llmMessages,
                tools: scopedTools.length > 0 ? scopedTools : undefined,
            } as any);

            toolCalls = response.choices?.[0]?.message?.tool_calls ?? [];
            fullContent = response.choices?.[0]?.message?.content ?? fullContent;
        }

        if (iteration >= maxIterations) {
            fullContent += `\n\n> **Note:** Maximum tool call steps (${maxIterations}) reached. If the dashboard was created, check the tool calls above for its UID and open it at /d/{uid}. To add remaining panels, ask me to continue, or increase the limit in the Graft plugin settings at ${SETTINGS_PATH}.`;
        }

        return {
            stepId: step.id,
            status: 'success',
            summary: fullContent || `Dashboard step "${step.description}" completed with ${toolExecutions.length} tool call(s).`,
            toolExecutions,
        };
    } catch (err: any) {
        if (err.message === 'Aborted') {
            throw err;
        }
        return {
            stepId: step.id,
            status: 'error',
            summary: `Dashboard step "${step.description}" failed.`,
            error: err.message,
            toolExecutions,
        };
    }
}
