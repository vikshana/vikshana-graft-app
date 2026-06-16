import { llm } from '@grafana/llm';
import type { ToolExecution } from '../../types/llm.types';
import type { PlanStep, SpecialistResult, DataFindings, LokiFindings, PrometheusFindings } from './types';
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
 * Tools whose results must be preserved verbatim and never compressed.
 * These tools produce structured data that is passed directly as input
 * to the next tool call (e.g. get_dashboard_by_uid → update_dashboard).
 */
const NO_COMPRESS_TOOLS = new Set([
    'get_dashboard_by_uid',
    'get_dashboard_panel_queries',
    'get_dashboard_property',
    'get_dashboard_summary',
]);

function compressToolResult(toolName: string, rawContent: string): string {
    if (NO_COMPRESS_TOOLS.has(toolName)) {
        return rawContent;
    }
    const preview = rawContent.length > 300 ? rawContent.slice(0, 300) + '...' : rawContent;
    return `[${toolName} result processed — summary: ${preview}]`;
}

function scopeTools(allTools: any[], categories: string[]): any[] {
    const allowed = new Set<string>();
    for (const cat of categories) {
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
 * JSON output schema injected into the system prompt for Loki data steps.
 * The specialist must return this structure so the dashboard agent can use
 * pre-validated queries without re-querying Loki.
 */
const LOKI_OUTPUT_SCHEMA = `{
  "datasourceUid": "<uid of the Loki datasource you used>",
  "datasourceName": "<name of the Loki datasource>",
  "labels": { "<label_name>": ["<value1>", "<value2>"] },
  "validatedQueries": [
    { "description": "<what this query shows>", "logql": "<the LogQL expression>" }
  ]
}`;

/**
 * JSON output schema injected into the system prompt for Prometheus data steps.
 */
const PROMETHEUS_OUTPUT_SCHEMA = `{
  "datasourceUid": "<uid of the Prometheus datasource you used>",
  "datasourceName": "<name of the Prometheus datasource>",
  "validatedQueries": [
    { "description": "<what this query shows>", "promql": "<the PromQL expression>" }
  ]
}`;

/**
 * Builds the data-output extension to the specialist system prompt.
 * Only injected for steps that include loki or prometheus in their toolCategories.
 */
function buildDataOutputNote(categories: string[]): string {
    const hasLoki = categories.includes('loki');
    const hasPrometheus = categories.includes('prometheus');
    if (!hasLoki && !hasPrometheus) { return ''; }

    const schema = hasLoki ? LOKI_OUTPUT_SCHEMA : PROMETHEUS_OUTPUT_SCHEMA;
    const queryTool = hasLoki ? 'query_loki_logs' : 'query_prometheus';
    const labelDiscovery = hasLoki
        ? `- Before writing any equality matchers (e.g. detected_level="error"), first discover the REAL label values by running a broad query or calling the label-values tool. Do NOT guess label values — use only values you have actually seen returned by a tool call.`
        : `- Before writing any label selectors (e.g. {job="api"}), first discover the actual label values by querying the Prometheus API or running a broad metric query. Do NOT guess label values.
- IMPORTANT: calling list_prometheus_label_names, list_prometheus_label_values, or list_prometheus_metric_names alone is NOT sufficient — those are discovery tools only. You MUST call query_prometheus with each PromQL expression before including it in your output.`;

    return `

Query validation rules (MUST follow exactly):
${labelDiscovery}
- You MUST call ${queryTool} for EVERY query you intend to include in your output — not just one. Run each query individually and check that it returns data.
- Only include queries that actually returned results when you called ${queryTool}. If a query returns no data (empty result, no streams, no series), revise the expression or omit it entirely.
- NEVER include a query in your output that you did not explicitly call ${queryTool} with and confirm returned data.
- When you output the JSON, copy the EXACT expression string you used in the ${queryTool} call — do not rephrase, reformat, or reconstruct it from memory.

Output format (required): when you have finished, respond with ONLY a JSON object matching this schema — no prose, no markdown fences:
${schema}

If no queries could be validated, return the schema with an empty validatedQueries array.`;
}

/**
 * Normalises a query expression for comparison: lowercase, collapse whitespace.
 * Used to match the expr the model executed against the expr it output in findings.
 */
function normaliseExpr(expr: string): string {
    return expr.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Attempts to parse a Loki query result and determine if it is non-empty.
 * A result is non-empty when it contains at least one stream/value entry.
 */
function isLokiResultNonEmpty(raw: string): boolean {
    try {
        const parsed = JSON.parse(raw);
        // MCP tool result is wrapped in content array: [{type:'text', text:'...'}]
        const text = Array.isArray(parsed)
            ? (parsed[0]?.text ?? parsed[0]?.content ?? '')
            : (parsed?.text ?? parsed?.content ?? raw);
        const inner = typeof text === 'string' ? JSON.parse(text) : text;
        // Loki HTTP API: { data: { result: [...] } }
        const result = inner?.data?.result ?? inner?.result ?? inner;
        return Array.isArray(result) && result.length > 0;
    } catch {
        // If we can't parse the result, assume non-empty (conservative — don't drop it).
        return true;
    }
}

/**
 * Attempts to parse a Prometheus query result and determine if it is non-empty.
 */
function isPrometheusResultNonEmpty(raw: string): boolean {
    try {
        const parsed = JSON.parse(raw);
        const text = Array.isArray(parsed)
            ? (parsed[0]?.text ?? parsed[0]?.content ?? '')
            : (parsed?.text ?? parsed?.content ?? raw);
        const inner = typeof text === 'string' ? JSON.parse(text) : text;
        // Prometheus HTTP API: { data: { result: [...] } }
        const result = inner?.data?.result ?? inner?.result ?? inner;
        return Array.isArray(result) && result.length > 0;
    } catch {
        return true;
    }
}

/**
 * Record of a successfully-executed query tool call, keyed by the normalised expression.
 * `nonEmpty` is true when the result contained at least one stream/series.
 */
type ExecutedQueryRecord = Map<string, boolean>;

/**
 * Code-enforced query validation gate (per Anthropic best practices).
 *
 * The specialist is prompted to call query_loki_logs / query_prometheus before
 * including a query in its output AND for every individual query it will output.
 * But the model can skip validation for some queries under pressure (e.g. it validates
 * one broad query then pads the findings with plausible-but-unverified narrow queries
 * like detected_level="error" that produce empty panels).
 *
 * This function enforces two layers:
 *   1. Gate: at least one successful query tool call must exist (existing check).
 *   2. Per-query filter: each entry in validatedQueries is kept only if its
 *      expression was actually executed AND returned non-empty data. Unverified or
 *      empty-returning queries are silently dropped.
 *
 * "stop_reason is the authoritative signal, not the model's prose claims."
 *   — Anthropic, Building Effective Agents
 */
function parseDataFindings(
    content: string,
    categories: string[],
    toolExecutions: ToolExecution[],
    executedQueries: ExecutedQueryRecord
): DataFindings | undefined {
    const hasLoki = categories.includes('loki');
    const hasPrometheus = categories.includes('prometheus');
    if (!hasLoki && !hasPrometheus) { return undefined; }

    // Layer 1: at least one successful query tool call should have occurred.
    // If the query tool was NOT called, we still allow datasource-only findings
    // (datasourceUid + empty validatedQueries) so the dashboard agent can use the
    // correct datasource UID even when no queries were verified. All validatedQueries
    // will be dropped by Layer 2 anyway since executedQueries will be empty.
    const requiredTool = hasLoki ? 'query_loki_logs' : 'query_prometheus';
    const queryToolWasCalled = toolExecutions.some(
        t => t.name === requiredTool && t.status === 'success'
    );

    if (!queryToolWasCalled) {
        console.warn(
            `[Graft] parseDataFindings: ${requiredTool} was not successfully called. ` +
            `Attempting to extract datasource info only — validated queries will be empty. ` +
            `The dashboard agent will receive the correct datasource UID but must write its own queries.`
        );
        // Fall through — parse what we can. Layer 2 will filter all queries since
        // executedQueries is empty. We still return datasource-only findings if the
        // specialist output a valid JSON schema with a datasourceUid.
    }

    try {
        // Extract JSON — handle any surrounding text or fences
        let json = content.trim();
        const fenceMatch = json.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fenceMatch) {
            json = fenceMatch[1].trim();
        } else {
            const start = json.indexOf('{');
            const end = json.lastIndexOf('}');
            if (start !== -1 && end !== -1 && end > start) {
                json = json.slice(start, end + 1);
            }
        }

        const parsed = JSON.parse(json);

        // Basic schema validation
        if (!parsed.datasourceUid || !Array.isArray(parsed.validatedQueries)) {
            return undefined;
        }

        // Layer 2: per-query filter — keep only queries that were actually executed
        // and returned non-empty data. This prevents the model from padding findings
        // with plausible-but-unverified narrow queries (e.g. detected_level="error")
        // that it never ran and that produce "No data" panels.
        const exprField = hasLoki ? 'logql' : 'promql';
        const filteredQueries = (parsed.validatedQueries as any[]).filter(q => {
            const expr = q?.[exprField];
            if (!expr || typeof expr !== 'string') { return false; }
            const norm = normaliseExpr(expr);
            const nonEmpty = executedQueries.get(norm);
            if (nonEmpty === undefined) {
                // Query was never executed — drop it
                console.warn(`[Graft] parseDataFindings: dropping unexecuted query: ${expr}`);
                return false;
            }
            if (!nonEmpty) {
                // Query was executed but returned no data — drop it
                console.warn(`[Graft] parseDataFindings: dropping empty-result query: ${expr}`);
                return false;
            }
            return true;
        });

        if (hasLoki) {
            const findings: LokiFindings = {
                datasourceUid: parsed.datasourceUid,
                datasourceName: parsed.datasourceName ?? '',
                labels: parsed.labels ?? {},
                validatedQueries: filteredQueries,
            };
            return { loki: findings };
        }

        const findings: PrometheusFindings = {
            datasourceUid: parsed.datasourceUid,
            datasourceName: parsed.datasourceName ?? '',
            validatedQueries: filteredQueries,
        };
        return { prometheus: findings };
    } catch {
        return undefined;
    }
}

/**
 * Builds a human-readable summary from DataFindings for the synthesiser.
 * Used when the specialist's full response is the JSON findings object
 * rather than prose — ensures the synthesiser still gets readable input.
 */
function buildSummaryFromFindings(findings: DataFindings, stepDescription: string): string {
    const parts: string[] = [`${stepDescription} completed.`];

    if (findings.loki) {
        const q = findings.loki.validatedQueries.length;
        parts.push(`Loki datasource: ${findings.loki.datasourceName} (uid: ${findings.loki.datasourceUid}).`);
        parts.push(`Validated ${q} LogQL ${q === 1 ? 'query' : 'queries'}: ${findings.loki.validatedQueries.map(q => q.description).join(', ')}.`);
    }
    if (findings.prometheus) {
        const q = findings.prometheus.validatedQueries.length;
        parts.push(`Prometheus datasource: ${findings.prometheus.datasourceName} (uid: ${findings.prometheus.datasourceUid}).`);
        parts.push(`Validated ${q} PromQL ${q === 1 ? 'query' : 'queries'}: ${findings.prometheus.validatedQueries.map(q => q.description).join(', ')}.`);
    }

    return parts.join(' ');
}

/**
 * Runs a single specialist agent for the given plan step.
 * Data steps (loki/prometheus) produce structured DataFindings alongside a prose summary.
 * Dashboard steps should use runDashboardAgent instead.
 */
export async function runSpecialist(
    step: PlanStep,
    userMessage: string,
    context: string,
    allTools: any[],
    mcpClient: any,
    maxIterations: number,
    signal: AbortSignal,
    onUpdate: (stepId: string, toolExecutions: ToolExecution[]) => void
): Promise<SpecialistResult> {
    const scopedTools = scopeTools(allTools, step.toolCategories);
    const dataOutputNote = buildDataOutputNote(step.toolCategories);

    const systemPrompt = `You are a specialist agent inside Graft, an AI assistant for Grafana.
Your role: ${step.description}
Available tool categories: ${step.toolCategories.join(', ')}

When you have completed your task, respond with a concise summary of what you found or did.
Do NOT produce a full user-facing response — your output will be combined with other agents' results.
If a tool returns an error, explain what failed briefly and continue if possible.${dataOutputNote}`;

    const llmMessages: any[] = [
        { role: 'system', content: systemPrompt + (context ? `\n\n${context}` : '') },
        { role: 'user', content: userMessage },
    ];

    const toolExecutions: ToolExecution[] = [];
    // Per-query execution record: normalised expr → whether the result was non-empty.
    // Built as tools are called; used by parseDataFindings to filter findings.
    const executedQueries: ExecutedQueryRecord = new Map();
    let fullContent = '';
    let iteration = 0;

    // Determine which query tools to track for this step
    const isLokiStep = step.toolCategories.includes('loki');
    const isPrometheusStep = step.toolCategories.includes('prometheus');
    const queryToolName = isLokiStep ? 'query_loki_logs' : isPrometheusStep ? 'query_prometheus' : null;

    try {
        let response = await llm.chatCompletions({
            model: llm.Model.BASE,
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

                    // Track executed query expressions for the per-query validation gate.
                    // We record whether the result was non-empty so parseDataFindings can
                    // drop findings entries whose queries returned no data.
                    if (toolCall.function.name === queryToolName) {
                        const expr: string = args?.expr ?? args?.query ?? '';
                        if (expr) {
                            const norm = normaliseExpr(expr);
                            const nonEmpty = isLokiStep
                                ? isLokiResultNonEmpty(rawResult)
                                : isPrometheusResultNonEmpty(rawResult);
                            // If the same expr is run multiple times, preserve non-empty over empty.
                            if (!executedQueries.has(norm) || nonEmpty) {
                                executedQueries.set(norm, nonEmpty);
                            }
                        }
                    }
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

            // Compress prior tool results before the next LLM call
            for (const toolCall of toolCalls) {
                const msgIdx = findLastIndex(
                    llmMessages,
                    (m: any) => m.role === 'tool' && m.tool_call_id === toolCall.id
                );
                if (msgIdx !== -1) {
                    const originalContent = llmMessages[msgIdx].content;
                    llmMessages[msgIdx] = {
                        ...llmMessages[msgIdx],
                        content: compressToolResult(toolCall.function.name, originalContent),
                    };
                }
            }

            if (signal.aborted) {
                throw new Error('Aborted');
            }

            response = await llm.chatCompletions({
                model: llm.Model.BASE,
                messages: llmMessages,
                tools: scopedTools.length > 0 ? scopedTools : undefined,
            } as any);

            toolCalls = response.choices?.[0]?.message?.tool_calls ?? [];
            fullContent = response.choices?.[0]?.message?.content ?? fullContent;
        }

        // Fix 2B: For data steps, request structured JSON output explicitly.
        // Only applies when the loop completed normally (not exhausted).
        // If the loop ended with prose, make a follow-up call to coerce JSON output.
        // NOTE: response_format is NOT used here — the Grafana LLM proxy does not
        // support it (ChatCompletionsRequest has no such field). parseDataFindings
        // extracts JSON from prose via fence/brace detection, which is sufficient.
        const isDataStep = step.toolCategories.some(c => c === 'loki' || c === 'prometheus');
        if (isDataStep && fullContent && iteration < maxIterations) {
            const looksLikeJson = fullContent.trim().startsWith('{') || fullContent.includes('datasourceUid');
            if (!looksLikeJson && !signal.aborted) {
                try {
                    const schema = step.toolCategories.includes('loki') ? LOKI_OUTPUT_SCHEMA : PROMETHEUS_OUTPUT_SCHEMA;
                    const jsonResponse = await llm.chatCompletions({
                        model: llm.Model.BASE,
                        messages: [
                            ...llmMessages,
                            { role: 'assistant', content: fullContent },
                            {
                                role: 'user',
                                content: `Now output your findings as a JSON object matching this schema exactly:\n${schema}\nOutput only the JSON object, nothing else.`,
                            },
                        ],
                    } as any);
                    const jsonContent = jsonResponse.choices?.[0]?.message?.content;
                    if (jsonContent) {
                        fullContent = jsonContent;
                    }
                } catch {
                    // If the follow-up fails, proceed with whatever fullContent we have
                }
            }
        }

        if (iteration >= maxIterations) {
            fullContent += `\n\n> **Note:** Maximum tool call steps (${maxIterations}) reached for this step. Results may be incomplete. You can increase the limit in the Graft plugin settings at ${SETTINGS_PATH}.`;
        }

        // For data steps, parse the JSON findings and build a human-readable summary.
        // Passes toolExecutions as ground truth (layer 1: query tool was called) and
        // executedQueries as the per-query validation record (layer 2: each query returned data).
        const dataFindings = parseDataFindings(fullContent, step.toolCategories, toolExecutions, executedQueries);
        const summary = dataFindings
            ? buildSummaryFromFindings(dataFindings, step.description)
            : (fullContent || `Step "${step.description}" completed with ${toolExecutions.length} tool call(s).`);

        return {
            stepId: step.id,
            status: 'success',
            summary,
            toolExecutions,
            dataFindings,
        };
    } catch (err: any) {
        if (err.message === 'Aborted') {
            throw err;
        }
        return {
            stepId: step.id,
            status: 'error',
            summary: `Step "${step.description}" failed.`,
            error: err.message,
            toolExecutions,
        };
    }
}
