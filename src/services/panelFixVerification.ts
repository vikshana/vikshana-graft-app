import type { ToolExecution } from '../types/llm.types';
import { extractDashboardFromGetByUid } from './programmaticDashboardClone';
import { callMcpTool } from './mcpToolClient';
import type { McpClient } from './dashboardChunkedUpdate';
import { resolvePanelForScopedFix } from './panelDiscovery';
import { formatScopedPanelCrossReference } from './panelCrossReference';
import { formatPanelVerificationBlock, scanPanelFluxIssues } from './panelFluxVerification';
import type { ScopedPanelFixTarget } from './panelFixScope';
import { isExplicitScopedPanelFixCommand, parseScopedPanelFixRequest } from './panelFixScope';
import { userWantsBulkPeerBandFix } from './bulkPeerBandFixParse';
import { isCrossDashboardPeerBandCopyIntent } from './peerBandShared';
import {
    getPanelFixResolvedPanel,
    getPanelFixScope,
    setPanelFixBaseline,
    setPanelFixResolvedPanel,
    setPanelFixScope,
} from './panelFixSessionStorage';

export interface PanelFixVerificationResult {
    ok: boolean;
    error?: string;
    reply: string;
    toolExecutions: ToolExecution[];
    issuesFound: number;
}

function pendingTool(name: string): ToolExecution {
    return { name, status: 'pending' };
}

function finishTool(step: ToolExecution, outcome: { ok: boolean; error?: string; summary?: string }): ToolExecution {
    return {
        ...step,
        status: outcome.ok ? 'success' : 'error',
        error: outcome.error,
        summary: outcome.summary,
    };
}

/** Follow-up: re-load dashboard and check the last scoped panel for known bad Flux patterns. */
export async function runPanelFixVerification(
    mcpClient: McpClient,
    scope: ScopedPanelFixTarget,
    userMessage: string
): Promise<PanelFixVerificationResult> {
    const toolExecutions: ToolExecution[] = [];

    if (!scope.dashboardUid) {
        return {
            ok: false,
            error: 'No dashboard uid in session',
            reply: '### Need clarification\n\nWhich dashboard should Graft verify? Include dashboard **uid** and panel name or panel id.',
            toolExecutions,
            issuesFound: 0,
        };
    }

    const getStep = pendingTool('get_dashboard_by_uid');
    toolExecutions.push(getStep);
    const getResult = await callMcpTool(mcpClient, 'get_dashboard_by_uid', { uid: scope.dashboardUid });
    toolExecutions[toolExecutions.length - 1] = finishTool(getStep, getResult);

    if (!getResult.ok) {
        return {
            ok: false,
            error: getResult.error ?? 'Could not load dashboard',
            reply: `### Could not verify\n\n${getResult.error ?? 'Could not load dashboard.'}`,
            toolExecutions,
            issuesFound: 0,
        };
    }

    const extracted = extractDashboardFromGetByUid(getResult.text);
    if (!extracted?.dashboard) {
        return {
            ok: false,
            error: 'Could not parse dashboard JSON',
            reply: '### Could not verify\n\nCould not parse dashboard JSON from Grafana.',
            toolExecutions,
            issuesFound: 0,
        };
    }

    const dashboard = extracted.dashboard;
    setPanelFixBaseline(dashboard);

    const resolved = resolvePanelForScopedFix(dashboard, scope);
    if (!resolved.ok) {
        return {
            ok: false,
            error: resolved.error,
            reply: `### Could not verify\n\n${resolved.error}`,
            toolExecutions,
            issuesFound: 0,
        };
    }

    const { entry, warning } = resolved.resolved;
    const effectiveScope: ScopedPanelFixTarget = {
        dashboardUid: scope.dashboardUid,
        panelId: entry.panelId,
        panelTitle: entry.title || scope.panelTitle,
        panelArrayIndex: entry.arrayIndex,
    };
    setPanelFixScope(effectiveScope);
    setPanelFixResolvedPanel({
        panelId: entry.panelId,
        panelTitle: entry.title,
        panelArrayIndex: entry.arrayIndex,
    });

    const issues = scanPanelFluxIssues(entry.panel);
    const dashboardTitle =
        typeof dashboard.title === 'string' && dashboard.title.trim() ? dashboard.title.trim() : undefined;
    const dashboardLabel = dashboardTitle
        ? `**${dashboardTitle}** (uid \`${scope.dashboardUid}\`)`
        : `dashboard uid \`${scope.dashboardUid}\``;
    const panelLabel = formatScopedPanelCrossReference(userMessage, effectiveScope, getPanelFixResolvedPanel());
    const verifyBlock = formatPanelVerificationBlock(issues);
    const warnBlock = warning ? `${warning}\n\n` : '';

    const reply =
        issues.length === 0
            ? `### Verified (panel fix)\n\n${warnBlock}${dashboardLabel} — ${panelLabel}: ${verifyBlock}`
            : `### Verification — issues remain\n\n${warnBlock}${dashboardLabel} — ${panelLabel}:\n\n${verifyBlock}\n\n` +
              `**What to do:** Reply **Continue** to retry the automatic Flux fix, or paste the Grafana error text for targets **${issues.map((i) => i.refId).join(', ')}**.`;

    return {
        ok: issues.length === 0,
        reply,
        toolExecutions,
        issuesFound: issues.length,
    };
}

export function resolvePanelFixScopeForFollowUp(
    userMessage: string,
    parseScoped: (message: string) => ScopedPanelFixTarget | null
): ScopedPanelFixTarget | null {
    if (userWantsBulkPeerBandFix(userMessage) || isCrossDashboardPeerBandCopyIntent(userMessage)) {
        return null;
    }
    return parseScoped(userMessage) ?? getPanelFixScope();
}

export function isPanelFixVerificationRequest(message: string): boolean {
    const text = message.trim();
    if (!text) {
        return false;
    }
    return (
        /\b(verify|verification|confirm|check)\b/i.test(text) &&
        /\b(panel|query|queries|errors?|fixed|save|saved|dashboard)\b/i.test(text)
    ) || /\b(look at|inspect)\b/i.test(text) && /\b(panel|errors?)\b/i.test(text);
}

export function shouldRunProgrammaticScopedPanelFix(
    userMessage: string,
    options?: { isContinue?: boolean; hasSessionScope?: boolean }
): boolean {
    if (options?.isContinue && options?.hasSessionScope) {
        return true;
    }
    if (messageTriggersProgrammaticFluxFix(userMessage)) {
        return true;
    }
    if (isExplicitScopedPanelFixCommand(userMessage)) {
        return true;
    }
    return false;
}

export function messageTriggersProgrammaticFluxFix(message: string): boolean {
    const text = message.trim();
    if (!text) {
        return false;
    }
    if (userWantsBulkPeerBandFix(text)) {
        return true;
    }
    return (
        /\b(flux|stddev|group by|unexpected argument|undefined identifier|max series|truncated|accumulator)\b/i.test(
            text
        ) ||
        /\bStatus:\s*\d+/i.test(text) ||
        /\bparse error\b/i.test(text) ||
        (/\b(error|errors)\b/i.test(text) &&
            /\b(panel|target|query|queries|dashboard)\b/i.test(text))
    );
}
