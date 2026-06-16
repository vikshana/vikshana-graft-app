import type { Message, ToolExecution } from '../../types/llm.types';
import type { ToolsConfig } from '../../types/settings.types';
import type {
    AgentPlan,
    PlanStep,
    SpecialistResult,
    OrchestrationUpdate,
    ToolCategory,
    DataFindings,
} from './types';
import { TOOL_CATEGORIES } from '../toolFilter';
import { llmService } from '../llm';
import { runPlanner } from './planner';
import { runSpecialist } from './specialist';
import { runDashboardAgent } from './dashboardAgent';
import { runSynthesiser } from './synthesiser';

function getEnabledCategories(toolsConfig?: ToolsConfig): ToolCategory[] {
    if (!toolsConfig) {
        return Object.keys(TOOL_CATEGORIES) as ToolCategory[];
    }
    return (Object.keys(TOOL_CATEGORIES) as ToolCategory[]).filter(
        cat => toolsConfig[cat]?.enabled !== false
    );
}

/**
 * Builds a compact digest of recent conversation turns for the planner.
 *
 * The planner otherwise only sees the latest user message. A follow-up like
 * "build a dashboard for monitoring it" loses the context of an earlier turn
 * that established the data lives in Loki — causing a lone dashboard step with
 * no data dependency and, ultimately, the wrong datasource on panels.
 *
 * We exclude the latest user message (it is passed separately as the request)
 * and cap both the number of turns and each turn's length to keep the prompt small.
 */
export function buildConversationDigest(messages: Message[], maxTurns = 6, maxCharsPerTurn = 500): string {
    const relevant = messages.filter(m => m.role === 'user' || m.role === 'assistant');
    // Drop the final user message — it is the request being planned.
    if (relevant.length > 0 && relevant[relevant.length - 1].role === 'user') {
        relevant.pop();
    }
    const recent = relevant.slice(-maxTurns);
    return recent
        .map(m => {
            const text = (m.content ?? '').trim().replace(/\s+/g, ' ');
            if (!text) { return ''; }
            const truncated = text.length > maxCharsPerTurn ? text.slice(0, maxCharsPerTurn) + '…' : text;
            return `${m.role === 'user' ? 'User' : 'Assistant'}: ${truncated}`;
        })
        .filter(Boolean)
        .join('\n');
}

function buildExecutionWaves(steps: PlanStep[]): PlanStep[][] {
    const waves: PlanStep[][] = [];
    const completed = new Set<string>();
    const remaining = [...steps];

    while (remaining.length > 0) {
        const wave = remaining.filter(step =>
            step.dependsOn.every(dep => completed.has(dep))
        );

        if (wave.length === 0) {
            waves.push([remaining[0]]);
            completed.add(remaining[0].id);
            remaining.splice(0, 1);
            continue;
        }

        waves.push(wave);
        for (const step of wave) {
            completed.add(step.id);
            remaining.splice(remaining.indexOf(step), 1);
        }
    }

    return waves;
}

/**
 * Merges DataFindings from a single SpecialistResult into the accumulated
 * findings object. Loki and Prometheus findings are merged separately.
 * Last-write wins if two steps produce findings for the same datasource type.
 */
function mergeDataFindings(accumulated: DataFindings, incoming?: DataFindings): DataFindings {
    if (!incoming) { return accumulated; }
    return {
        loki: incoming.loki ?? accumulated.loki,
        prometheus: incoming.prometheus ?? accumulated.prometheus,
    };
}

/**
 * Returns true if the step is a dashboard-creation/editing step.
 * These are routed to the dedicated dashboard agent instead of the generic specialist.
 */
function isDashboardStep(step: PlanStep): boolean {
    return step.toolCategories.includes('dashboards');
}

/** Data-source categories that should never be mixed with dashboards in one step. */
const DATA_CATEGORIES: ToolCategory[] = ['loki', 'prometheus', 'datasources'];

/** Categories that supply validated queries (DataFindings) to the dashboard agent. */
const QUERY_DATA_CATEGORIES: ToolCategory[] = ['loki', 'prometheus'];

/** Keyword hints used to infer which datasource a dashboard step needs. */
const LOKI_KEYWORDS = /\b(log|logs|logging|loki|logql|stderr|stdout|log\s*level|log\s*volume)\b/i;
const PROMETHEUS_KEYWORDS = /\b(metric|metrics|prometheus|promql|cpu|memory|latency|rate|throughput|request\s*rate|error\s*rate|gauge|counter|histogram|saturation)\b/i;

/**
 * Infers which data categories a dashboard step needs, based on the step
 * description and recent conversation. Returns only categories that are enabled.
 *
 * - mentions logs/loki → ['loki']
 * - mentions metrics/prometheus → ['prometheus']
 * - mentions both, or neither (ambiguous) → both enabled query categories
 */
export function inferDataCategoriesForDashboard(
    text: string,
    enabledCategories: ToolCategory[],
): ToolCategory[] {
    const enabledQuery = QUERY_DATA_CATEGORIES.filter(c => enabledCategories.includes(c));
    if (enabledQuery.length === 0) { return []; }

    const wantsLoki = LOKI_KEYWORDS.test(text) && enabledQuery.includes('loki');
    const wantsPrometheus = PROMETHEUS_KEYWORDS.test(text) && enabledQuery.includes('prometheus');

    if (wantsLoki && !wantsPrometheus) { return ['loki']; }
    if (wantsPrometheus && !wantsLoki) { return ['prometheus']; }
    // Both mentioned, or neither matched → cover all enabled query categories.
    return enabledQuery;
}

/**
 * Code-enforced plan sanitiser — the poka-yoke gate between the Planner and execution.
 *
 * The Planner is instructed (prompt-only) to keep dashboard steps separate from data
 * steps and to always precede a data dashboard with a data step. But a BASE model
 * under pressure produces two failure modes that both leave the dashboard agent with
 * empty DataFindings and the wrong datasource on panels:
 *
 *   1. A mixed step like ["loki", "dashboards"] — split into a data step + dashboard step.
 *   2. A lone ["dashboards"] step with no data dependency — inject a preceding data step.
 *
 * Example (mixed split):
 *   BEFORE: { id: "step_1", toolCategories: ["loki", "dashboards"], dependsOn: [] }
 *   AFTER:  { id: "step_1",          toolCategories: ["loki"],       dependsOn: [] }
 *           { id: "step_1_dashboard", toolCategories: ["dashboards"], dependsOn: ["step_1"] }
 *
 * Example (injection):
 *   BEFORE: { id: "step_1", toolCategories: ["dashboards"], dependsOn: [] }   // "build a logs dashboard"
 *   AFTER:  { id: "step_1_data", toolCategories: ["loki"],        dependsOn: [] }
 *           { id: "step_1",      toolCategories: ["dashboards"],  dependsOn: ["step_1_data"] }
 *
 * Runs after every Planner call, before buildExecutionWaves.
 * No LLM call — pure structural transformation, O(n) in the number of steps.
 *
 * @param enabledCategories Used to scope any injected data step to enabled tools.
 * @param requestText The user request + conversation digest, used to infer loki vs prometheus.
 */
export function sanitisePlan(
    plan: AgentPlan,
    enabledCategories: ToolCategory[] = Object.keys(TOOL_CATEGORIES) as ToolCategory[],
    requestText = '',
): AgentPlan {
    // ─── Pass 1: split mixed data+dashboard steps ───────────────────────────────
    const split: PlanStep[] = [];
    let splitCount = 0;

    for (const step of plan.steps) {
        const hasDashboards = step.toolCategories.includes('dashboards');
        const dataCategories = step.toolCategories.filter(
            c => DATA_CATEGORIES.includes(c as ToolCategory)
        );

        if (hasDashboards && dataCategories.length > 0) {
            // Split: data step first, dashboard step depends on it
            splitCount++;
            const dataStepId = step.id;
            const dashStepId = `${step.id}_dashboard`;

            split.push({
                id: dataStepId,
                description: step.description.replace(/\s*(and\s+)?create\s+(a\s+)?dashboard.*/i, '').trim()
                    || `Gather data for: ${step.description}`,
                toolCategories: dataCategories as ToolCategory[],
                dependsOn: step.dependsOn,
            });

            split.push({
                id: dashStepId,
                description: `Build dashboard: ${step.description}`,
                toolCategories: ['dashboards'],
                dependsOn: [...step.dependsOn, dataStepId],
            });

            console.info(`[Graft] Plan sanitiser: split mixed step "${step.id}" into "${dataStepId}" + "${dashStepId}"`);
        } else {
            split.push(step);
        }
    }

    // ─── Pass 2: inject a data step for any dashboard step lacking a data dependency ─
    // A dashboard step gets its DataFindings from upstream loki/prometheus steps. If
    // none exist anywhere in its dependency chain, the dashboard agent has no validated
    // queries and guesses the datasource. We inject a data step and wire the dependency.
    const stepsById = new Map(split.map(s => [s.id, s]));

    const hasQueryDataAncestor = (step: PlanStep, seen = new Set<string>()): boolean => {
        for (const depId of step.dependsOn) {
            if (seen.has(depId)) { continue; }
            seen.add(depId);
            const dep = stepsById.get(depId);
            if (!dep) { continue; }
            if (dep.toolCategories.some(c => QUERY_DATA_CATEGORIES.includes(c))) { return true; }
            if (hasQueryDataAncestor(dep, seen)) { return true; }
        }
        return false;
    };

    const injected: PlanStep[] = [];
    let injectCount = 0;

    for (const step of split) {
        const isDashboard = step.toolCategories.includes('dashboards');
        if (isDashboard && !hasQueryDataAncestor(step)) {
            const inferText = `${step.description} ${requestText}`;
            const categories = inferDataCategoriesForDashboard(inferText, enabledCategories);

            if (categories.length > 0) {
                injectCount++;
                const dataStepId = `${step.id}_data`;
                injected.push({
                    id: dataStepId,
                    description: `Discover and validate ${categories.join(' and ')} queries for: ${step.description}`,
                    toolCategories: categories,
                    dependsOn: [...step.dependsOn],
                });
                injected.push({ ...step, dependsOn: [...step.dependsOn, dataStepId] });
                console.info(`[Graft] Plan sanitiser: injected data step "${dataStepId}" (${categories.join(', ')}) before lone dashboard step "${step.id}"`);
                continue;
            }
        }
        injected.push(step);
    }

    if (splitCount === 0 && injectCount === 0) {
        return plan;
    }

    return {
        ...plan,
        complexity: 'complex', // ensure complex path runs after restructuring
        steps: injected,
    };
}

/**
 * Main orchestrator entry point.
 *
 * Flow:
 * 1. Planner decomposes the request
 * 2. Simple → delegate to llmService.chat
 * 3. Complex → run waves; data steps go to runSpecialist, dashboard steps to runDashboardAgent
 * 4. Synthesiser combines results into the final response
 */
export async function runOrchestration(
    messages: Message[],
    context: string,
    allTools: any[],
    mcpClient: any,
    modelType: 'standard' | 'thinking',
    maxIterations: number,
    signal: AbortSignal,
    toolsConfig: ToolsConfig | undefined,
    onUpdate: (update: OrchestrationUpdate) => void
): Promise<string> {
    const userMessages = messages.filter(m => m.role === 'user');
    const userMessage = userMessages[userMessages.length - 1]?.content ?? '';

    const enabledCategories = getEnabledCategories(toolsConfig);
    const conversationDigest = buildConversationDigest(messages);

    // Step 1: Plan — give the planner recent conversation so it can resolve
    // references (e.g. "it" → the Loki service from an earlier turn). Then sanitise
    // to enforce structural rules in code: split mixed steps and inject a data step
    // for any lone dashboard step so the dashboard agent always has validated queries.
    const rawPlan: AgentPlan = await runPlanner(userMessage, context, enabledCategories, conversationDigest);
    const plan = sanitisePlan(rawPlan, enabledCategories, `${userMessage}\n${conversationDigest}`);
    onUpdate({ type: 'plan', plan });

    if (signal.aborted) {
        throw new Error('Aborted');
    }

    // Step 2: Simple path — delegate to the existing single-agent loop.
    // Emit step_start so the UI shows the step description and flips PlanBlock
    // to "View plan". After llmService.chat resolves, emit 'final' so ChatInterface
    // writes the content to the message (same contract as the complex path).
    if (plan.complexity === 'simple') {
        const stepId = plan.steps[0]?.id ?? 'step_1';
        const stepDescription = plan.steps[0]?.description ?? userMessage;

        onUpdate({ type: 'step_start', stepId, stepDescription });

        const result = await llmService.chat(
            messages,
            context,
            (content: string, toolExecutions?: ToolExecution[]) => {
                onUpdate({ type: 'step_update', stepId, toolExecutions, content });
            },
            modelType,
            signal,
            mcpClient,
            allTools
        );

        onUpdate({ type: 'final', content: result });
        return result;
    }

    // Step 3: Complex path — run waves, accumulating DataFindings across waves
    const waves = buildExecutionWaves(plan.steps);
    const allResults: SpecialistResult[] = [];
    let collectedFindings: DataFindings = {};

    for (const wave of waves) {
        if (signal.aborted) {
            throw new Error('Aborted');
        }

        for (const step of wave) {
            onUpdate({ type: 'step_start', stepId: step.id, stepDescription: step.description });
        }

        const waveResults = await Promise.allSettled(
            wave.map(step => {
                if (isDashboardStep(step)) {
                    // Route to the purpose-built dashboard agent with collected findings.
                    // Dashboard construction is step-intensive; give it 2× the configured limit.
                    return runDashboardAgent(
                        step,
                        userMessage,
                        context,
                        collectedFindings,
                        allTools,
                        mcpClient,
                        Math.min(maxIterations * 2, 100),
                        signal,
                        (stepId, toolExecutions) => {
                            onUpdate({ type: 'step_update', stepId, toolExecutions });
                        }
                    );
                }

                // Generic data specialist (loki, prometheus, datasources)
                return runSpecialist(
                    step,
                    userMessage,
                    context,
                    allTools,
                    mcpClient,
                    maxIterations,
                    signal,
                    (stepId, toolExecutions) => {
                        onUpdate({ type: 'step_update', stepId, toolExecutions });
                    }
                );
            })
        );

        for (let i = 0; i < wave.length; i++) {
            const settled = waveResults[i];
            let result: SpecialistResult;

            if (settled.status === 'fulfilled') {
                result = settled.value;
            } else {
                const errMsg = settled.reason?.message ?? 'Unknown error';
                if (errMsg === 'Aborted') {
                    throw new Error('Aborted');
                }
                result = {
                    stepId: wave[i].id,
                    status: 'error',
                    summary: `Step "${wave[i].description}" failed unexpectedly.`,
                    error: errMsg,
                    toolExecutions: [],
                };
            }

            // Accumulate DataFindings from data specialists for the dashboard agent
            collectedFindings = mergeDataFindings(collectedFindings, result.dataFindings);

            allResults.push(result);
            onUpdate({ type: 'step_done', stepId: result.stepId, toolExecutions: result.toolExecutions });
        }
    }

    if (signal.aborted) {
        throw new Error('Aborted');
    }

    // Step 4: Synthesise
    const finalContent = await runSynthesiser(userMessage, allResults, modelType);
    onUpdate({ type: 'final', content: finalContent });

    return finalContent;
}
