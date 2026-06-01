import type { ToolExecution } from '../types/llm.types';

/** Append uid/panel index tables to the assistant reply when tools ran but the model omitted them. */
export function appendDashboardReferencesToReply(content: string, toolExecutions: ToolExecution[]): string {
    const blocks = toolExecutions
        .map((t) => t.userReference?.trim())
        .filter((b): b is string => Boolean(b));

    if (blocks.length === 0) {
        return content;
    }

    const marker = 'Dashboard lookup reference';
    const panelMarker = 'Panel index';
    if (content.includes(marker) || content.includes(panelMarker)) {
        return content;
    }

    return `${content.trim()}\n\n${blocks.join('\n\n')}`;
}

/** True if the model claimed a dashboard save without a successful update_dashboard tool call. */
export function claimsDashboardSaveWithoutTool(content: string, toolExecutions: ToolExecution[]): boolean {
    const claimed =
        /\b(successfully updated|I've updated|dashboard was saved|titles now read|all \d+ panel)/i.test(content);
    const saved = toolExecutions.some((t) => t.name === 'update_dashboard' && t.status === 'success');
    return claimed && !saved;
}

export function appendSaveVerificationWarning(content: string, toolExecutions: ToolExecution[]): string {
    if (!claimsDashboardSaveWithoutTool(content, toolExecutions)) {
        return content;
    }
    return (
        `${content.trim()}\n\n---\n` +
        `**Note:** No confirmed \`update_dashboard\` save was recorded in this turn. ` +
        `The changes above may not be on the server — expand the tool steps above or ask Graft to save again with your dashboard **uid** and **panel index**.\n`
    );
}
