import { runOrchestration, sanitisePlan } from './orchestrator';
import * as planner from './planner';
import * as specialist from './specialist';
import * as dashboardAgentModule from './dashboardAgent';
import * as synthesiser from './synthesiser';
import * as llmServiceModule from '../llm';
import type { AgentPlan, SpecialistResult, OrchestrationUpdate } from './types';
import type { Message } from '../../types/llm.types';

// Mock @grafana/llm to avoid ESM issues with pkce-challenge transitive dep
jest.mock('@grafana/llm', () => ({
    llm: {
        chatCompletions: jest.fn(),
        Model: { BASE: 'base', LARGE: 'large' },
    },
    mcp: {
        useMCPClient: jest.fn().mockReturnValue({ enabled: false, client: null }),
        convertToolsToOpenAI: jest.fn().mockReturnValue([]),
    },
}));

jest.mock('./planner');
jest.mock('./specialist');
jest.mock('./dashboardAgent');
jest.mock('./synthesiser');
jest.mock('../llm');

const mockRunPlanner = planner.runPlanner as jest.Mock;
const mockRunSpecialist = specialist.runSpecialist as jest.Mock;
const mockRunDashboardAgent = dashboardAgentModule.runDashboardAgent as jest.Mock;
const mockRunSynthesiser = synthesiser.runSynthesiser as jest.Mock;
const mockLlmServiceChat = (llmServiceModule.llmService as any).chat as jest.Mock;

const userMsg: Message = { role: 'user', content: 'build a dashboard' };

const simplePlan: AgentPlan = {
    complexity: 'simple',
    reasoning: 'Single query.',
    steps: [{ id: 'step_1', description: 'Query metrics', toolCategories: ['prometheus'], dependsOn: [] }],
};

const complexPlan: AgentPlan = {
    complexity: 'complex',
    reasoning: 'Needs data then dashboard.',
    steps: [
        { id: 'step_1', description: 'Fetch Prometheus', toolCategories: ['prometheus'], dependsOn: [] },
        { id: 'step_2', description: 'Fetch Loki', toolCategories: ['loki'], dependsOn: [] },
        { id: 'step_3', description: 'Build dashboard', toolCategories: ['dashboards'], dependsOn: ['step_1', 'step_2'] },
    ],
};

const successResult = (stepId: string): SpecialistResult => ({
    stepId,
    status: 'success',
    summary: `${stepId} done.`,
    toolExecutions: [],
});

describe('runOrchestration', () => {
    let onUpdate: jest.Mock<void, [OrchestrationUpdate]>;

    beforeEach(() => {
        jest.clearAllMocks();
        onUpdate = jest.fn();
        mockRunSynthesiser.mockResolvedValue('Final synthesised response.');
        mockLlmServiceChat.mockResolvedValue('Simple response.');
        mockRunDashboardAgent.mockResolvedValue(successResult('step_3'));
    });

    describe('simple path', () => {
        it('delegates to llmService.chat when plan is simple', async () => {
            mockRunPlanner.mockResolvedValue(simplePlan);

            const result = await runOrchestration(
                [userMsg], '', [], null, 'standard', 10,
                new AbortController().signal, undefined, onUpdate
            );

            expect(mockLlmServiceChat).toHaveBeenCalled();
            expect(mockRunSpecialist).not.toHaveBeenCalled();
            expect(mockRunSynthesiser).not.toHaveBeenCalled();
            expect(result).toBe('Simple response.');
        });

        it('emits plan update before delegating', async () => {
            mockRunPlanner.mockResolvedValue(simplePlan);

            await runOrchestration(
                [userMsg], '', [], null, 'standard', 10,
                new AbortController().signal, undefined, onUpdate
            );

            expect(onUpdate).toHaveBeenCalledWith(
                expect.objectContaining({ type: 'plan', plan: simplePlan })
            );
        });

        it('emits step_start with step description before llmService.chat', async () => {
            mockRunPlanner.mockResolvedValue(simplePlan);

            await runOrchestration(
                [userMsg], '', [], null, 'standard', 10,
                new AbortController().signal, undefined, onUpdate
            );

            expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({
                type: 'step_start',
                stepId: simplePlan.steps[0].id,
                stepDescription: simplePlan.steps[0].description,
            }));
        });

        it('emits final event with the result after llmService.chat resolves', async () => {
            mockRunPlanner.mockResolvedValue(simplePlan);

            await runOrchestration(
                [userMsg], '', [], null, 'standard', 10,
                new AbortController().signal, undefined, onUpdate
            );

            expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({
                type: 'final',
                content: 'Simple response.',
            }));
        });

        it('step_start is emitted before final', async () => {
            mockRunPlanner.mockResolvedValue(simplePlan);

            const updateOrder: string[] = [];
            onUpdate.mockImplementation((u: any) => updateOrder.push(u.type));

            await runOrchestration(
                [userMsg], '', [], null, 'standard', 10,
                new AbortController().signal, undefined, onUpdate
            );

            const stepStartIdx = updateOrder.indexOf('step_start');
            const finalIdx = updateOrder.indexOf('final');
            expect(stepStartIdx).toBeGreaterThanOrEqual(0);
            expect(finalIdx).toBeGreaterThan(stepStartIdx);
        });
    });

    describe('complex path', () => {
        it('routes data steps to runSpecialist and dashboard step to runDashboardAgent', async () => {
            mockRunPlanner.mockResolvedValue(complexPlan);
            mockRunSpecialist
                .mockResolvedValueOnce(successResult('step_1'))
                .mockResolvedValueOnce(successResult('step_2'));
            // mockRunDashboardAgent already set to return successResult('step_3') in beforeEach

            const result = await runOrchestration(
                [userMsg], '', [], {}, 'standard', 10,
                new AbortController().signal, undefined, onUpdate
            );

            expect(mockRunPlanner).toHaveBeenCalledTimes(1);
            expect(mockRunSpecialist).toHaveBeenCalledTimes(2); // step_1 (prometheus) + step_2 (loki)
            expect(mockRunDashboardAgent).toHaveBeenCalledTimes(1); // step_3 (dashboards)
            expect(mockRunSynthesiser).toHaveBeenCalledTimes(1);
            expect(result).toBe('Final synthesised response.');
        });

        it('passes collectedFindings to the dashboard agent', async () => {
            const lokiFindings = {
                datasourceUid: 'loki-uid',
                datasourceName: 'Loki',
                labels: { job: ['api'] },
                validatedQueries: [{ description: 'errors', logql: '{job="api"} |= "error"' }],
            };
            mockRunPlanner.mockResolvedValue(complexPlan);
            mockRunSpecialist
                .mockResolvedValueOnce({ ...successResult('step_1'), dataFindings: undefined })
                .mockResolvedValueOnce({ ...successResult('step_2'), dataFindings: { loki: lokiFindings } });

            await runOrchestration(
                [userMsg], '', [], {}, 'standard', 10,
                new AbortController().signal, undefined, onUpdate
            );

            // Dashboard agent should receive the Loki findings from step_2
            expect(mockRunDashboardAgent).toHaveBeenCalledWith(
                expect.anything(),        // step
                expect.anything(),        // userMessage
                expect.anything(),        // context
                expect.objectContaining({ loki: lokiFindings }), // dataFindings
                expect.anything(),        // allTools
                expect.anything(),        // mcpClient
                expect.anything(),        // maxIterations
                expect.anything(),        // signal
                expect.anything()         // onUpdate
            );
        });

        it('passes 2× maxIterations (capped at 100) to the dashboard agent', async () => {
            mockRunPlanner.mockResolvedValue(complexPlan);
            mockRunSpecialist
                .mockResolvedValueOnce(successResult('step_1'))
                .mockResolvedValueOnce(successResult('step_2'));

            await runOrchestration(
                [userMsg], '', [], {}, 'standard', 20,
                new AbortController().signal, undefined, onUpdate
            );

            // maxIterations = 20, dashboard agent should receive 40
            expect(mockRunDashboardAgent).toHaveBeenCalledWith(
                expect.anything(), expect.anything(), expect.anything(),
                expect.anything(), expect.anything(), expect.anything(),
                40,  // Math.min(20 * 2, 100)
                expect.anything(), expect.anything()
            );
        });

        it('caps dashboard agent iterations at 100', async () => {
            mockRunPlanner.mockResolvedValue(complexPlan);
            mockRunSpecialist
                .mockResolvedValueOnce(successResult('step_1'))
                .mockResolvedValueOnce(successResult('step_2'));

            await runOrchestration(
                [userMsg], '', [], {}, 'standard', 80,
                new AbortController().signal, undefined, onUpdate
            );

            // maxIterations = 80, 80*2=160, capped at 100
            expect(mockRunDashboardAgent).toHaveBeenCalledWith(
                expect.anything(), expect.anything(), expect.anything(),
                expect.anything(), expect.anything(), expect.anything(),
                100,  // Math.min(80 * 2, 100)
                expect.anything(), expect.anything()
            );
        });

        it('runs steps with no dependsOn in parallel (same wave)', async () => {
            mockRunPlanner.mockResolvedValue(complexPlan);

            const callOrder: string[] = [];
            mockRunSpecialist.mockImplementation(async (step: any) => {
                callOrder.push(`start:${step.id}`);
                await Promise.resolve(); // yield to microtask queue
                callOrder.push(`end:${step.id}`);
                return successResult(step.id);
            });

            await runOrchestration(
                [userMsg], '', [], {}, 'standard', 10,
                new AbortController().signal, undefined, onUpdate
            );

            // step_1 and step_2 should both start before either ends (parallel)
            const start1 = callOrder.indexOf('start:step_1');
            const start2 = callOrder.indexOf('start:step_2');
            const end1 = callOrder.indexOf('end:step_1');
            const end2 = callOrder.indexOf('end:step_2');

            expect(start1).toBeLessThan(end2);
            expect(start2).toBeLessThan(end1);
        });

        it('runs step_3 (dashboard) only after step_1 and step_2 complete', async () => {
            mockRunPlanner.mockResolvedValue(complexPlan);

            const completedBeforeStep3: string[] = [];
            mockRunSpecialist.mockImplementation(async (step: any) => {
                const result = successResult(step.id);
                completedBeforeStep3.push(step.id);
                return result;
            });
            mockRunDashboardAgent.mockImplementation(async (step: any) => {
                // At this point, step_1 and step_2 should already be done
                expect(completedBeforeStep3).toContain('step_1');
                expect(completedBeforeStep3).toContain('step_2');
                return successResult(step.id);
            });

            await runOrchestration(
                [userMsg], '', [], {}, 'standard', 10,
                new AbortController().signal, undefined, onUpdate
            );
        });

        it('emits step_start and step_done updates for each step', async () => {
            mockRunPlanner.mockResolvedValue({
                complexity: 'complex',
                reasoning: 'test',
                steps: [{ id: 'step_1', description: 'Fetch', toolCategories: ['prometheus'], dependsOn: [] }],
            });
            mockRunSpecialist.mockResolvedValue(successResult('step_1'));

            await runOrchestration(
                [userMsg], '', [], {}, 'standard', 10,
                new AbortController().signal, undefined, onUpdate
            );

            expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ type: 'step_start', stepId: 'step_1' }));
            expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ type: 'step_done', stepId: 'step_1' }));
        });

        it('emits final update with synthesiser content', async () => {
            mockRunPlanner.mockResolvedValue({
                complexity: 'complex',
                reasoning: 'test',
                steps: [{ id: 'step_1', description: 'Fetch', toolCategories: ['prometheus'], dependsOn: [] }],
            });
            mockRunSpecialist.mockResolvedValue(successResult('step_1'));

            await runOrchestration(
                [userMsg], '', [], {}, 'standard', 10,
                new AbortController().signal, undefined, onUpdate
            );

            expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({
                type: 'final',
                content: 'Final synthesised response.',
            }));
        });

        it('continues when one specialist fails (does not throw)', async () => {
            mockRunPlanner.mockResolvedValue({
                complexity: 'complex',
                reasoning: 'test',
                steps: [
                    { id: 'step_1', description: 'Fetch metrics', toolCategories: ['prometheus'], dependsOn: [] },
                    { id: 'step_2', description: 'Fetch logs', toolCategories: ['loki'], dependsOn: [] },
                ],
            });

            const failResult: SpecialistResult = {
                stepId: 'step_1', status: 'error', summary: 'Failed.', error: 'timeout', toolExecutions: [],
            };
            mockRunSpecialist
                .mockResolvedValueOnce(failResult)
                .mockResolvedValueOnce(successResult('step_2'));

            const result = await runOrchestration(
                [userMsg], '', [], {}, 'standard', 10,
                new AbortController().signal, undefined, onUpdate
            );

            expect(mockRunSynthesiser).toHaveBeenCalledWith(
                expect.anything(),
                expect.arrayContaining([
                    expect.objectContaining({ stepId: 'step_1', status: 'error' }),
                    expect.objectContaining({ stepId: 'step_2', status: 'success' }),
                ]),
                expect.anything()
            );
            expect(result).toBe('Final synthesised response.');
        });

        it('throws when AbortSignal is aborted before wave execution', async () => {
            const controller = new AbortController();
            mockRunPlanner.mockImplementation(async () => {
                controller.abort();
                return complexPlan;
            });

            await expect(
                runOrchestration(
                    [userMsg], '', [], {}, 'standard', 10,
                    controller.signal, undefined, onUpdate
                )
            ).rejects.toThrow('Aborted');
        });
    });
});

// ─── sanitisePlan unit tests ────────────────────────────────────────────────

describe('sanitisePlan (Fix 1: code-enforced plan gate)', () => {
    const makeStep = (id: string, cats: string[], deps: string[] = []) => ({
        id,
        description: `Step ${id}`,
        toolCategories: cats as any,
        dependsOn: deps,
    });

    it('returns plan unchanged when no steps mix loki and dashboards', () => {
        const plan = {
            complexity: 'complex' as const,
            reasoning: 'test',
            steps: [
                makeStep('step_1', ['loki']),
                makeStep('step_2', ['dashboards'], ['step_1']),
            ],
        };
        const result = sanitisePlan(plan);
        expect(result.steps).toHaveLength(2);
        expect(result).toBe(plan); // same reference — no copy made
    });

    it('splits a mixed ["loki", "dashboards"] step into two', () => {
        const plan = {
            complexity: 'complex' as const,
            reasoning: 'test',
            steps: [makeStep('step_1', ['loki', 'dashboards'])],
        };
        const result = sanitisePlan(plan);

        expect(result.steps).toHaveLength(2);
        expect(result.steps[0].id).toBe('step_1');
        expect(result.steps[0].toolCategories).toEqual(['loki']);
        expect(result.steps[0].dependsOn).toEqual([]);

        expect(result.steps[1].id).toBe('step_1_dashboard');
        expect(result.steps[1].toolCategories).toEqual(['dashboards']);
        expect(result.steps[1].dependsOn).toContain('step_1');
    });

    it('preserves original dependsOn on the data step after split', () => {
        const plan = {
            complexity: 'complex' as const,
            reasoning: 'test',
            steps: [
                makeStep('step_0', ['datasources']),
                makeStep('step_1', ['prometheus', 'dashboards'], ['step_0']),
            ],
        };
        const result = sanitisePlan(plan);
        const dataStep = result.steps.find(s => s.id === 'step_1')!;
        expect(dataStep.dependsOn).toContain('step_0');
        // Does NOT contain step_1_dashboard (only upstream deps)
        expect(dataStep.dependsOn).not.toContain('step_1_dashboard');

        const dashStep = result.steps.find(s => s.id === 'step_1_dashboard')!;
        expect(dashStep.dependsOn).toContain('step_0');
        expect(dashStep.dependsOn).toContain('step_1');
    });

    it('forces complexity to complex after splitting a simple plan', () => {
        const plan = {
            complexity: 'simple' as const,
            reasoning: 'test',
            steps: [makeStep('step_1', ['loki', 'dashboards'])],
        };
        const result = sanitisePlan(plan);
        expect(result.complexity).toBe('complex');
    });

    it('handles multiple mixed steps in the same plan', () => {
        const plan = {
            complexity: 'complex' as const,
            reasoning: 'test',
            steps: [
                makeStep('step_1', ['loki', 'dashboards']),
                makeStep('step_2', ['prometheus', 'dashboards']),
            ],
        };
        const result = sanitisePlan(plan);
        expect(result.steps).toHaveLength(4);
        expect(result.steps.map(s => s.id)).toEqual([
            'step_1', 'step_1_dashboard', 'step_2', 'step_2_dashboard',
        ]);
    });

    it('sanitised plan is executed correctly through runOrchestration', async () => {
        // The planner emits a mixed step — sanitiser should split it before execution
        const mixedPlan: AgentPlan = {
            complexity: 'complex',
            reasoning: 'Mixed step test',
            steps: [{ id: 'step_1', description: 'Fetch Loki and build dashboard', toolCategories: ['loki', 'dashboards'] as any, dependsOn: [] }],
        };

        const mockRunPlanner = planner.runPlanner as jest.Mock;
        const mockRunSpecialist = specialist.runSpecialist as jest.Mock;
        const mockRunDashboardAgent = dashboardAgentModule.runDashboardAgent as jest.Mock;
        const mockRunSynthesiser = synthesiser.runSynthesiser as jest.Mock;

        mockRunPlanner.mockResolvedValue(mixedPlan);
        mockRunSpecialist.mockResolvedValue(successResult('step_1'));
        mockRunDashboardAgent.mockResolvedValue(successResult('step_1_dashboard'));
        mockRunSynthesiser.mockResolvedValue('Final answer.');

        const onUpdate = jest.fn();
        await runOrchestration(
            [{ role: 'user', content: 'build dashboard' }],
            '', [], {}, 'standard', 10,
            new AbortController().signal, undefined, onUpdate
        );

        // Specialist should have been called for the data step (loki only)
        expect(mockRunSpecialist).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'step_1', toolCategories: ['loki'] }),
            expect.anything(), expect.anything(), expect.anything(),
            expect.anything(), expect.anything(), expect.anything(), expect.anything()
        );

        // Dashboard agent should have been called for the split dashboard step
        expect(mockRunDashboardAgent).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'step_1_dashboard', toolCategories: ['dashboards'] }),
            expect.anything(), expect.anything(), expect.anything(),
            expect.anything(), expect.anything(), expect.anything(),
            expect.anything(), expect.anything()
        );
    });
});
