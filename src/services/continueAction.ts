import type { ToolExecution } from '../types/llm.types';

/** User message sent when continuing an incomplete dashboard task. */
export const CONTINUE_USER_MESSAGE = 'Continue';

/** Auto-continue / banner sends this; hide from the message list so the thread stays readable. */
export function isSyntheticContinueUserMessage(msg: { role: string; content: string }): boolean {
    return msg.role === 'user' && /^continue\.?$/i.test(msg.content.trim());
}

/** Extra UI-side auto-continue rounds after the LLM loop (discovery-only stops). */
export const MAX_UI_AUTO_CONTINUE_ROUNDS = 3;

export const CONTINUE_ACTION_HEADING = '### ⏸ Action required';

/** Prominent block appended to operator-facing status messages. */
export function formatContinueActionBlock(detail?: string): string {
    const line = detail ?? 'Graft stopped before finishing.';
    return (
        `\n\n${CONTINUE_ACTION_HEADING}\n\n` +
        `> **${line}**\n>\n` +
        '> Use the **Continue** button below (or type `Continue`) — you do not need panel numbers or UIDs. ' +
        `Graft will also try to **continue automatically** when possible.\n`
    );
}

/** True when the assistant bubble should show the Continue button / auto-continue. */
export function responseNeedsContinueAction(content: string): boolean {
    if (!content.trim()) {
        return false;
    }
    if (/^###\s*Done\b/im.test(content.trim())) {
        return false;
    }
    return (
        /###\s*Not finished yet/i.test(content) ||
        /###\s*Stuck\s*[—-]/i.test(content) ||
        /###\s*⏸\s*Action required/i.test(content) ||
        /\*\*Dashboard clone not finished\*\*/i.test(content) ||
        /\*\*Stopped after the maximum automated tool steps\*\*/i.test(content) ||
        /\*\*Note:\*\* Graft stopped for confirmation before saving/i.test(content)
    );
}

export function hasSuccessfulDashboardSave(toolExecutions: ToolExecution[] = []): boolean {
    return toolExecutions.some((t) => t.name === 'update_dashboard' && t.status === 'success');
}
