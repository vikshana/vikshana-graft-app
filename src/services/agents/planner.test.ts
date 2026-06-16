import { runPlanner } from './planner';

const mockChatCompletions = jest.fn();

jest.mock('@grafana/llm', () => ({
    llm: {
        chatCompletions: (...args: any[]) => mockChatCompletions(...args),
        Model: { BASE: 'base', LARGE: 'large' },
    },
}));

const makePlanResponse = (plan: object) => ({
    choices: [{ message: { content: JSON.stringify(plan) } }],
});

describe('runPlanner', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('returns a simple plan for a single-category request', async () => {
        const plan = {
            complexity: 'simple',
            reasoning: 'Single metric query.',
            steps: [{ id: 'step_1', description: 'Query CPU usage', toolCategories: ['prometheus'], dependsOn: [] }],
        };
        mockChatCompletions.mockResolvedValue(makePlanResponse(plan));

        const result = await runPlanner('show me CPU usage', '', ['prometheus', 'loki']);

        expect(result.complexity).toBe('simple');
        expect(result.steps).toHaveLength(1);
        expect(result.steps[0].toolCategories).toContain('prometheus');
    });

    it('returns a complex multi-step plan with dependsOn populated', async () => {
        const plan = {
            complexity: 'complex',
            reasoning: 'Needs data fetch then dashboard creation.',
            steps: [
                { id: 'step_1', description: 'Fetch Prometheus metrics', toolCategories: ['prometheus'], dependsOn: [] },
                { id: 'step_2', description: 'Fetch Loki logs', toolCategories: ['loki'], dependsOn: [] },
                { id: 'step_3', description: 'Build dashboard', toolCategories: ['dashboards'], dependsOn: ['step_1', 'step_2'] },
            ],
        };
        mockChatCompletions.mockResolvedValue(makePlanResponse(plan));

        const result = await runPlanner(
            'build a dashboard with Prometheus metrics and Loki errors',
            '',
            ['prometheus', 'loki', 'dashboards']
        );

        expect(result.complexity).toBe('complex');
        expect(result.steps).toHaveLength(3);
        expect(result.steps[2].dependsOn).toEqual(['step_1', 'step_2']);
    });

    it('uses only Model.BASE — never Model.LARGE', async () => {
        mockChatCompletions.mockResolvedValue(makePlanResponse({
            complexity: 'simple',
            reasoning: 'test',
            steps: [{ id: 'step_1', description: 'test', toolCategories: ['prometheus'], dependsOn: [] }],
        }));

        await runPlanner('test', '', ['prometheus']);

        expect(mockChatCompletions).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'base' })
        );
    });

    it('includes enabled category names in the prompt', async () => {
        mockChatCompletions.mockResolvedValue(makePlanResponse({
            complexity: 'simple',
            reasoning: 'test',
            steps: [{ id: 'step_1', description: 'test', toolCategories: ['loki'], dependsOn: [] }],
        }));

        await runPlanner('test', '', ['loki', 'prometheus']);

        const call = mockChatCompletions.mock.calls[0][0];
        const userContent = call.messages.find((m: any) => m.role === 'user')?.content ?? '';
        expect(userContent).toContain('loki');
        expect(userContent).toContain('prometheus');
    });

    it('falls back to simple plan on malformed JSON from model', async () => {
        mockChatCompletions.mockResolvedValue({
            choices: [{ message: { content: 'this is not json {{{' } }],
        });

        const result = await runPlanner('test request', '', ['prometheus']);

        expect(result.complexity).toBe('simple');
        expect(result.steps).toHaveLength(1);
    });

    it('falls back to simple plan on empty choices', async () => {
        mockChatCompletions.mockResolvedValue({ choices: [] });

        const result = await runPlanner('test request', '', ['loki']);

        expect(result.complexity).toBe('simple');
    });

    it('falls back to simple plan when model throws', async () => {
        mockChatCompletions.mockRejectedValue(new Error('LLM unavailable'));

        const result = await runPlanner('test request', '', ['prometheus']);

        expect(result.complexity).toBe('simple');
    });

    it('falls back to simple plan when plan has no steps', async () => {
        mockChatCompletions.mockResolvedValue(makePlanResponse({
            complexity: 'complex',
            reasoning: 'bad plan',
            steps: [],
        }));

        const result = await runPlanner('test', '', ['prometheus']);
        expect(result.complexity).toBe('simple');
    });

    it('strips markdown code fences from model response', async () => {
        const plan = {
            complexity: 'simple',
            reasoning: 'Direct.',
            steps: [{ id: 'step_1', description: 'Query', toolCategories: ['prometheus'], dependsOn: [] }],
        };
        mockChatCompletions.mockResolvedValue({
            choices: [{ message: { content: '```json\n' + JSON.stringify(plan) + '\n```' } }],
        });

        const result = await runPlanner('query CPU', '', ['prometheus']);
        expect(result.complexity).toBe('simple');
        expect(result.steps[0].toolCategories).toContain('prometheus');
    });
});
