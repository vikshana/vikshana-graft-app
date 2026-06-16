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

    // Step 1: Plan
    const plan: AgentPlan = await runPlanner(userMessage, context, enabledCategories);
    onUpdate({ type: 'plan', plan });

    if (signal.aborted) {
        throw new Error('Aborted');
    }

    // Step 2: Simple path
    if (plan.complexity === 'simple') {
        return llmService.chat(
            messages,
            context,
            (content: string, toolExecutions?: ToolExecution[]) => {
                onUpdate({ type: 'step_update', stepId: 'step_1', toolExecutions, content });
            },
            modelType,
            signal,
            mcpClient,
            allTools
        );
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
                    // Route to the purpose-built dashboard agent with collected findings
                    return runDashboardAgent(
                        step,
                        userMessage,
                        context,
                        collectedFindings,
                        allTools,
                        mcpClient,
                        maxIterations,
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
