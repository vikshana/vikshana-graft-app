import { llm } from '@grafana/llm';
import type { SpecialistResult } from './types';

/**
 * Post-processes the synthesiser output to ensure any Grafana dashboard UIDs
 * that the model left as plain text are converted to clickable markdown links.
 *
 * Matches patterns like:
 *   uid: abc123          → [abc123](/d/abc123)
 *   UID `abc123`         → [abc123](/d/abc123)
 *   dashboard abc123     → dashboard [abc123](/d/abc123)
 *
 * Does not re-process UIDs already wrapped in a markdown link.
 */
function linkifyDashboardUids(text: string): string {
    // Grafana dashboard UIDs are alphanumeric with hyphens/underscores, 6–40 chars
    // First pass: find all UIDs already in markdown links so we don't double-wrap
    const alreadyLinked = new Set<string>();
    const linkPattern = /\[([^\]]+)\]\(\/d\/([a-zA-Z0-9_-]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = linkPattern.exec(text)) !== null) {
        alreadyLinked.add(m[2]);
    }

    // Replace uid: <value>, UID `<value>`, (uid: <value>) patterns
    return text
        .replace(/\b(uid|UID):\s*`?([a-zA-Z0-9_-]{6,40})`?/g, (match, _label, uid) => {
            if (alreadyLinked.has(uid)) { return match; }
            alreadyLinked.add(uid);
            return `[${uid}](/d/${uid})`;
        })
        .replace(/`([a-zA-Z0-9_-]{6,40})`(?=\s*(was created|has been created|is available|dashboard))/gi, (match, uid) => {
            if (alreadyLinked.has(uid)) { return match; }
            alreadyLinked.add(uid);
            return `[\`${uid}\`](/d/${uid})`;
        });
}

/**
 * Combines the results of all specialist agents into a single, coherent
 * user-facing response. Explicitly informs the model about any failed steps
 * so it can transparently report them to the user.
 */
export async function runSynthesiser(
    userMessage: string,
    results: SpecialistResult[],
    modelType: 'standard' | 'thinking'
): Promise<string> {
    const successResults = results.filter(r => r.status === 'success');
    const failedResults = results.filter(r => r.status === 'error');

    const resultsSections: string[] = [];

    for (const r of successResults) {
        resultsSections.push(`### Step ${r.stepId} (succeeded)\n${r.summary}`);
    }

    for (const r of failedResults) {
        resultsSections.push(
            `### Step ${r.stepId} (failed)\nError: ${r.error ?? 'Unknown error'}\nPartial output: ${r.summary}`
        );
    }

    const systemPrompt = `You are the final response agent for Graft, an AI assistant embedded in Grafana.
You have been given summaries of work completed by specialist agents in response to a user request.
Your job is to synthesise these into a single, clear, user-facing response.

Guidelines:
- Use markdown formatting. Wrap PromQL in \`\`\`promql blocks, LogQL in \`\`\`logql blocks, JSON in \`\`\`json blocks.
- If any steps failed, explicitly tell the user what failed and why, alongside the results from successful steps.
- Do not repeat the agent summaries verbatim — synthesise them into a cohesive answer.
- Keep the response concise and focused on the user's original request.
- Dashboard links: if a Grafana dashboard was created or modified, always render its UID as a
  markdown link using the path \`/d/{uid}\`. For example: [Open dashboard](/d/abc123def).
  Never leave a dashboard UID as bare text.`;

    const userContent = `Original user request:
${userMessage}

Agent results:
${resultsSections.join('\n\n')}`;

    const response = await llm.chatCompletions({
        model: modelType === 'thinking' ? llm.Model.LARGE : llm.Model.BASE,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
        ],
    } as any);

    const raw = response.choices?.[0]?.message?.content ?? 'No response generated.';
    return linkifyDashboardUids(raw);
}
