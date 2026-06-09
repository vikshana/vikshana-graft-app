import type { ToolExecution } from '../types/llm.types';
import { extractDashboardUidFromMessage } from './dashboardMentionParse';
import { assistantAskedPendingQuestion } from './dashboardPendingTask';
import {
    layoutNeedsProgrammaticRepair,
    suggestRepairForLayoutIssues,
    validateDashboardLayout,
    layoutIssuesSummary,
} from './dashboardLayoutValidate';
import { extractDashboardFromGetByUid } from './programmaticDashboardClone';
import { callMcpTool } from './mcpToolClient';
import type { McpClient } from './dashboardChunkedUpdate';
import { contentHasLeakedToolCalls } from './leakedToolCallRecovery';
import { hasSuccessfulDashboardSave, responseNeedsContinueAction } from './continueAction';
import {
    parseDashboardRebuildRequest,
    userWantsDashboardRebuild,
} from './dashboardRebuildParse';
import {
    parseDashboardTitleRowRequest,
    userWantsDashboardTitleRow,
} from './dashboardTitleRowParse';
import {
    isModuleReorderConfirmation,
    parseModulePanelReorderRequest,
    userWantsModulePanelReorder,
} from './modulePanelReorderParse';
import { runProgrammaticDashboardRebuild, formatDashboardRebuildReply } from './programmaticDashboardLayoutRebuild';
import { runProgrammaticDashboardTitleRow, formatDashboardTitleRowReply } from './programmaticDashboardTitleRow';
import {
    runProgrammaticModulePanelReorder,
    formatModulePanelReorderReply,
} from './programmaticModulePanelReorder';
import {
    parseDashboardMetricPanelsRequest,
    userWantsDashboardMetricPanels,
} from './dashboardMetricPanelsParse';
import {
    runProgrammaticDashboardMetricPanels,
    formatDashboardMetricPanelsReply,
} from './programmaticDashboardMetricPanels';
import { messageDescribesPanelRename, userWantsPanelRename } from './panelRenameParse';
import {
    messageDescribesPanelRemove,
    parsePanelRemoveRequest,
    userWantsPanelRemove,
} from './panelRemoveParse';
import { formatPanelRemoveReply, runProgrammaticPanelRemove } from './programmaticPanelRemove';

export interface LlmTurnContext {
    userMessage: string;
    assistantContent: string;
    toolExecutions: ToolExecution[];
}

export type ProgrammaticFallbackKind =
    | 'dashboard_rebuild'
    | 'dashboard_title_row'
    | 'module_panel_reorder'
    | 'dashboard_metric_panels'
    | 'panel_remove';

export interface ProgrammaticFallbackPlan {
    kind: ProgrammaticFallbackKind;
    reason: string;
}

/** LLM stalled, asked unnecessary questions, leaked tools, or saved a layout that still fails validation. */
export function planProgrammaticFallback(ctx: LlmTurnContext): ProgrammaticFallbackPlan | null {
    const text = ctx.userMessage.trim();
    if (!text) {
        return null;
    }
    if (userWantsPanelRename(text) || messageDescribesPanelRename(text)) {
        return null;
    }
    if (userWantsPanelRemove(text) || messageDescribesPanelRemove(text)) {
        const removeReq = parsePanelRemoveRequest(text);
        const saved = hasSuccessfulDashboardSave(ctx.toolExecutions);
        const llmStalled =
            !saved &&
            (responseNeedsContinueAction(ctx.assistantContent) ||
                assistantAskedPendingQuestion(ctx.assistantContent) ||
                contentHasLeakedToolCalls(ctx.assistantContent));
        if (removeReq && (llmStalled || saved)) {
            return {
                kind: 'panel_remove',
                reason: saved
                    ? 'LLM saved but panel may still be present; removing programmatically with verification.'
                    : 'LLM stalled before removing the panel; applying programmatic panel remove.',
            };
        }
        return null;
    }

    const saved = hasSuccessfulDashboardSave(ctx.toolExecutions);
    const uid = extractDashboardUidFromMessage(text);

    const llmStalled =
        !saved &&
        (responseNeedsContinueAction(ctx.assistantContent) ||
            assistantAskedPendingQuestion(ctx.assistantContent) ||
            contentHasLeakedToolCalls(ctx.assistantContent) ||
            /\b(Would you like|Should I|Please provide|need clarification|What is this dashboard monitoring)\b/i.test(
                ctx.assistantContent
            ));

    const llmAskedDespiteUid =
        Boolean(uid) &&
        !saved &&
        /\b(Would you like|Should I|Please provide|What metrics|What panels)\b/i.test(ctx.assistantContent);

    if (llmStalled || llmAskedDespiteUid) {
        if (userWantsDashboardMetricPanels(text) && parseDashboardMetricPanelsRequest(text)) {
            return {
                kind: 'dashboard_metric_panels',
                reason: 'LLM leaked tool markup or stalled before saving metric panels; building panels programmatically from Prometheus.',
            };
        }
        if (userWantsDashboardRebuild(text) && parseDashboardRebuildRequest(text)) {
            return { kind: 'dashboard_rebuild', reason: 'LLM did not reorganize the dashboard; applying PowerTech layout programmatically.' };
        }
        if (userWantsDashboardTitleRow(text) && parseDashboardTitleRowRequest(text)) {
            return { kind: 'dashboard_title_row', reason: 'LLM did not fix the title row; applying title-row layout programmatically.' };
        }
        if (
            (userWantsModulePanelReorder(text) || isModuleReorderConfirmation(text)) &&
            parseModulePanelReorderRequest(text)
        ) {
            return { kind: 'module_panel_reorder', reason: 'LLM did not reorder module panels; applying module block layout programmatically.' };
        }
    }

    if (saved && (userWantsDashboardRebuild(text) || userWantsDashboardTitleRow(text) || userWantsModulePanelReorder(text))) {
        return { kind: 'dashboard_rebuild', reason: 'LLM saved but layout may still need repair; will validate after fetch.' };
    }

    return null;
}

export interface ProgrammaticFallbackResult {
    applied: boolean;
    kind?: ProgrammaticFallbackKind;
    reason?: string;
    content: string;
    toolExecutions: ToolExecution[];
}

async function fetchLayoutIssues(
    mcpClient: McpClient,
    uid: string,
    toolExecutions: ToolExecution[]
): Promise<{ issues: ReturnType<typeof validateDashboardLayout>; error?: string }> {
    const step: ToolExecution = { name: 'get_dashboard_by_uid', status: 'pending' };
    toolExecutions.push(step);
    const fetch = await callMcpTool(mcpClient, 'get_dashboard_by_uid', { uid });
    step.status = fetch.ok ? 'success' : 'error';
    step.error = fetch.error;
    step.summary = fetch.summary;
    if (!fetch.ok) {
        return { issues: [], error: fetch.error ?? 'Could not load dashboard' };
    }
    const extracted = extractDashboardFromGetByUid(fetch.text);
    const panels = Array.isArray(extracted?.dashboard?.panels)
        ? (extracted.dashboard.panels as Record<string, unknown>[])
        : [];
    return { issues: validateDashboardLayout(panels) };
}

/**
 * After an LLM turn: run a programmatic handler when we recognize a known failure pattern.
 * LLM stays primary; this is the safety net for repeatable layout failures.
 */
export async function tryProgrammaticFallbackAfterLlm(
    mcpClient: McpClient | null | undefined,
    ctx: LlmTurnContext,
    buildNumber: string | number
): Promise<ProgrammaticFallbackResult | null> {
    if (!mcpClient) {
        return null;
    }

    let plan = planProgrammaticFallback(ctx);
    const uid = extractDashboardUidFromMessage(ctx.userMessage);

    if (
        hasSuccessfulDashboardSave(ctx.toolExecutions) &&
        uid &&
        !userWantsPanelRename(ctx.userMessage) &&
        !messageDescribesPanelRename(ctx.userMessage) &&
        !userWantsPanelRemove(ctx.userMessage) &&
        !messageDescribesPanelRemove(ctx.userMessage)
    ) {
        const toolExecutions = [...ctx.toolExecutions];
        const { issues, error } = await fetchLayoutIssues(mcpClient, uid, toolExecutions);
        if (!error && layoutNeedsProgrammaticRepair(issues)) {
            const repair = suggestRepairForLayoutIssues(issues);
            plan =
                repair === 'module_reorder'
                    ? { kind: 'module_panel_reorder', reason: `Layout validation failed:\n${layoutIssuesSummary(issues)}` }
                    : repair === 'title_row'
                      ? { kind: 'dashboard_title_row', reason: `Layout validation failed:\n${layoutIssuesSummary(issues)}` }
                      : { kind: 'dashboard_rebuild', reason: `Layout validation failed:\n${layoutIssuesSummary(issues)}` };
        } else if (!plan) {
            return null;
        }
    }

    if (!plan) {
        return null;
    }

    if (plan.kind === 'dashboard_metric_panels') {
        const request = parseDashboardMetricPanelsRequest(ctx.userMessage);
        if (!request) {
            return null;
        }
        const result = await runProgrammaticDashboardMetricPanels(mcpClient, request);
        return {
            applied: true,
            kind: plan.kind,
            reason: plan.reason,
            content:
                (result.ok
                    ? `### Programmatic repair — ${plan.kind} (build ${buildNumber})\n\n` +
                      `_${plan.reason}_\n\n`
                    : `### Programmatic repair attempted — ${plan.kind} (build ${buildNumber})\n\n` +
                      `_${plan.reason}_\n\n`) +
                formatDashboardMetricPanelsReply(result, buildNumber).replace(/^###[^\n]+\n\n/, ''),
            toolExecutions: [...ctx.toolExecutions, ...result.toolExecutions],
        };
    }

    if (plan.kind === 'dashboard_rebuild') {
        const request = parseDashboardRebuildRequest(ctx.userMessage);
        if (!request) {
            return null;
        }
        const result = await runProgrammaticDashboardRebuild(mcpClient, request);
        if (!result.ok) {
            return null;
        }
        return {
            applied: true,
            kind: plan.kind,
            reason: plan.reason,
            content:
                `### Programmatic repair — ${plan.kind} (build ${buildNumber})\n\n` +
                `_${plan.reason}_\n\n` +
                formatDashboardRebuildReply(result, buildNumber).replace(/^###[^\n]+\n\n/, ''),
            toolExecutions: [...ctx.toolExecutions, ...result.toolExecutions],
        };
    }

    if (plan.kind === 'dashboard_title_row') {
        const request = parseDashboardTitleRowRequest(ctx.userMessage);
        if (!request) {
            return null;
        }
        const result = await runProgrammaticDashboardTitleRow(mcpClient, request);
        if (!result.ok) {
            return null;
        }
        return {
            applied: true,
            kind: plan.kind,
            reason: plan.reason,
            content:
                `### Programmatic repair — ${plan.kind} (build ${buildNumber})\n\n` +
                `_${plan.reason}_\n\n` +
                formatDashboardTitleRowReply(result, buildNumber).replace(/^###[^\n]+\n\n/, ''),
            toolExecutions: [...ctx.toolExecutions, ...result.toolExecutions],
        };
    }

    if (plan.kind === 'module_panel_reorder') {
        const request = parseModulePanelReorderRequest(ctx.userMessage);
        if (!request) {
            return null;
        }
        const result = await runProgrammaticModulePanelReorder(mcpClient, request);
        if (!result.ok) {
            return null;
        }
        return {
            applied: true,
            kind: plan.kind,
            reason: plan.reason,
            content:
                `### Programmatic repair — ${plan.kind} (build ${buildNumber})\n\n` +
                `_${plan.reason}_\n\n` +
                formatModulePanelReorderReply(result, buildNumber).replace(/^###[^\n]+\n\n/, ''),
            toolExecutions: [...ctx.toolExecutions, ...result.toolExecutions],
        };
    }

    if (plan.kind === 'panel_remove') {
        const request = parsePanelRemoveRequest(ctx.userMessage);
        if (!request) {
            return null;
        }
        const result = await runProgrammaticPanelRemove(mcpClient, request);
        return {
            applied: result.ok,
            kind: plan.kind,
            reason: plan.reason,
            content:
                (result.ok
                    ? `### Programmatic repair — ${plan.kind} (build ${buildNumber})\n\n` +
                      `_${plan.reason}_\n\n`
                    : `### Programmatic repair attempted — ${plan.kind} (build ${buildNumber})\n\n` +
                      `_${plan.reason}_\n\n`) +
                formatPanelRemoveReply(result, Number(buildNumber)).replace(/^###[^\n]+\n\n/, ''),
            toolExecutions: [...ctx.toolExecutions, ...result.toolExecutions],
        };
    }

    return null;
}

/** Documented registry — add a row when a new programmatic path is wired. */
export const PROGRAMMATIC_FALLBACK_REGISTRY: Array<{
    kind: ProgrammaticFallbackKind;
    triggers: string;
    handler: string;
}> = [
    {
        kind: 'dashboard_metric_panels',
        triggers: 'create N panels / every available metric / cover all metrics on instrumentation dashboard',
        handler: 'discoverPrometheusMetricsForMachine + stat panel grid',
    },
    {
        kind: 'dashboard_rebuild',
        triggers: 'rebuild / best practices / PowerTech conventions; grid overlap after LLM save',
        handler: 'applyBestPracticeDashboardLayout',
    },
    {
        kind: 'dashboard_title_row',
        triggers: 'title row at top; title shares y=0 with other panels',
        handler: 'applyDashboardTitleRow',
    },
    {
        kind: 'module_panel_reorder',
        triggers: 'Module N Current block interspersed or above non-module panels',
        handler: 'computeModulePanelSectionStartY + reorder',
    },
    {
        kind: 'panel_remove',
        triggers: 'remove/delete panel; LLM stalled or save did not remove panel',
        handler: 'runProgrammaticPanelRemove + post-save verification',
    },
];
