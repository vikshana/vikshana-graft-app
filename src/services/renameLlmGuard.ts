import type { Message, ToolExecution } from '../types/llm.types';
import { GRAFT_BUILD_NUMBER } from '../buildInfo';
import {
    formatDashboardRenameClarification,
    messageDescribesDashboardRename,
    parseDashboardRenameRequest,
} from './dashboardRenameParse';
import type { McpClient } from './dashboardChunkedUpdate';
import {
    formatDashboardRenameReply,
    runProgrammaticDashboardRename,
} from './programmaticDashboardRename';
import {
    formatPanelRenameClarification,
    messageDescribesPanelRename,
    parsePanelRenameRequest,
} from './panelRenameParse';
import {
    formatPanelRenameReply,
    runProgrammaticPanelRename,
} from './programmaticPanelRename';
import { contextService } from './context';

/** Eager-loaded from module.tsx so rename routing is not only in the lazy ChatInterface chunk. */
export const GRAFT_RENAME_LLM_GUARD = true;

function lastUserMessageContent(messages: Message[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'user') {
            return messages[i].content?.trim() ?? '';
        }
    }
    return '';
}

/**
 * Run programmatic panel or dashboard rename instead of the LLM when the latest user turn is a rename request.
 * Returns the assistant reply when handled; null when the LLM should run.
 */
export async function tryInterceptRenameBeforeLlm(
    messages: Message[],
    mcpClient: McpClient | undefined,
    onUpdate: (content: string, toolExecutions?: ToolExecution[]) => void
): Promise<string | null> {
    const lastUser = lastUserMessageContent(messages);
    const contextUid = contextService.getDashboardUid() ?? undefined;

    if (messageDescribesPanelRename(lastUser)) {
        const panelRequest = parsePanelRenameRequest(lastUser);
        if (!panelRequest) {
            const reply = formatPanelRenameClarification(lastUser);
            onUpdate(reply, []);
            return reply;
        }
        if (!mcpClient) {
            const reply =
                '### Could not rename panel\n\nGrafana MCP tools are not connected. Open **Grafana LLM / MCP settings**, enable MCP for Graft, hard-refresh this page, then try again.';
            onUpdate(reply, []);
            return reply;
        }
        const panelResult = await runProgrammaticPanelRename(mcpClient, panelRequest, {
            contextDashboardUid: contextUid,
        });
        const panelReply = formatPanelRenameReply(panelResult, GRAFT_BUILD_NUMBER);
        onUpdate(panelReply, panelResult.toolExecutions);
        return panelReply;
    }

    if (!messageDescribesDashboardRename(lastUser)) {
        return null;
    }

    const request = parseDashboardRenameRequest(lastUser);
    if (!request) {
        const reply = formatDashboardRenameClarification(lastUser);
        onUpdate(reply, []);
        return reply;
    }

    if (!mcpClient) {
        const reply =
            '### Could not rename dashboard\n\nGrafana MCP tools are not connected. Open **Grafana LLM / MCP settings**, enable MCP for Graft, hard-refresh this page, then try again.';
        onUpdate(reply, []);
        return reply;
    }

    const result = await runProgrammaticDashboardRename(mcpClient, request, {
        contextDashboardUid: contextUid,
    });
    const reply = formatDashboardRenameReply(result, GRAFT_BUILD_NUMBER);
    onUpdate(reply, result.toolExecutions);
    return reply;
}
