import { llm } from '@grafana/llm';
import type { AgentPlan, ToolCategory } from './types';

const PLANNER_SYSTEM_PROMPT = `You are a planning agent for Graft, an AI assistant embedded in Grafana.
Your job is to analyse a user request and produce a structured execution plan.

You must respond with ONLY a valid JSON object — no markdown, no explanation, no code fences.

Available tool categories and what they do:
- loki: Discover labels, validate and execute Loki log queries. Produces structured query findings for use by the dashboard category.
- prometheus: Discover metrics, validate and execute Prometheus queries. Produces structured query findings for use by the dashboard category.
- dashboards: Build or edit Grafana dashboards using pre-validated queries supplied by loki/prometheus steps. Always depends on data steps when building from queried data.
- datasources: List and look up Grafana datasources.

Rules for determining complexity:
- "simple": the request can be answered with a SINGLE tool category and at most 2 tool calls total
  (e.g. "show me CPU usage", "what Loki labels are available?")
- "complex": the request needs multiple tool categories, OR requires chaining results across steps,
  OR involves creating/modifying a dashboard with data from queries
  (e.g. "build a dashboard showing Loki errors and Prometheus latency")

Structural rules (must follow exactly):
- Never produce two steps with identical toolCategories. Consolidate them into a single step — a specialist can perform multiple queries within one loop.
- Dashboard construction must always be a separate step that lists ALL data steps in its dependsOn. Never include "dashboards" and "loki"/"prometheus" in the same step's toolCategories.
- A step with toolCategories ["dashboards"] will automatically receive the validated queries from all its dependency steps — it does not need loki or prometheus tools.
- Steps with no dependsOn can run in parallel.

For "simple" plans, return exactly one step with no dependsOn.
For "complex" plans, model the dependency graph precisely in dependsOn.

Response schema (strict):
{
  "complexity": "simple" | "complex",
  "reasoning": "<one sentence explaining the plan>",
  "steps": [
    {
      "id": "step_1",
      "description": "<what this step will do, shown to the user>",
      "toolCategories": ["<category>"],
      "dependsOn": []
    }
  ]
}`;

/**
 * Calls the LLM (BASE model) to decompose the user's request into a structured plan.
 * Falls back to a single-step simple plan if the model returns invalid JSON.
 */
export async function runPlanner(
    userMessage: string,
    context: string,
    enabledCategories: ToolCategory[]
): Promise<AgentPlan> {
    const categoriesStr = enabledCategories.length > 0
        ? enabledCategories.join(', ')
        : 'none (all tool categories are disabled)';

    const userPrompt = `Enabled tool categories: ${categoriesStr}

User request:
${userMessage}

${context ? `Current Grafana context:\n${context}` : ''}`;

    try {
        const response = await llm.chatCompletions({
            model: llm.Model.BASE,
            messages: [
                { role: 'system', content: PLANNER_SYSTEM_PROMPT },
                { role: 'user', content: userPrompt },
            ],
        } as any);

        const raw = response.choices?.[0]?.message?.content ?? '';

        // Extract JSON robustly: handle markdown fences anywhere in the response,
        // preamble text, and models that wrap JSON in ```json ... ``` blocks.
        let cleaned = raw.trim();

        // Try to extract a JSON block from a code fence first
        const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fenceMatch) {
            cleaned = fenceMatch[1].trim();
        } else {
            // No fence — find the first '{' and last '}' to isolate the JSON object
            const start = cleaned.indexOf('{');
            const end = cleaned.lastIndexOf('}');
            if (start !== -1 && end !== -1 && end > start) {
                cleaned = cleaned.slice(start, end + 1);
            }
        }

        const plan = JSON.parse(cleaned) as AgentPlan;

        // Validate required fields
        if (!plan.complexity || !Array.isArray(plan.steps) || plan.steps.length === 0) {
            throw new Error('Invalid plan structure');
        }

        return plan;
    } catch {
        // Graceful fallback: treat as simple single-agent request
        return {
            complexity: 'simple',
            reasoning: 'Could not parse a structured plan — falling back to direct response.',
            steps: [
                {
                    id: 'step_1',
                    description: userMessage,
                    toolCategories: enabledCategories.slice(0, 1),
                    dependsOn: [],
                },
            ],
        };
    }
}
