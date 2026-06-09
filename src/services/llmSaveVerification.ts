import type { ToolExecution } from '../types/llm.types';
import type { McpClient } from './dashboardChunkedUpdate';
import { callMcpTool } from './mcpToolClient';
import { extractDashboardFromGetByUid } from './programmaticDashboardClone';
import { extractDashboardUidFromMessage } from './dashboardMentionParse';
import { findPanelForRemoval, listDashboardPanels } from './panelDiscovery';
import { getTurnDashboardBaseline } from './llmDashboardSnapshot';
import { parsePanelRemoveRequest } from './panelRemoveParse';
import { parsePanelRenameRequest } from './panelRenameParse';
import { savedUidFromTools, savedVersionFromTools } from './dashboardSaveReplyUtils';
import { hasSuccessfulDashboardSave } from './continueAction';

export interface LlmSaveVerification {
    verified: boolean;
    skipped: boolean;
    uid?: string;
    version?: number;
    detail?: string;
    baselinePanelCount?: number;
    currentPanelCount?: number;
}

function panelTitlesFromDashboard(panels: unknown): string[] {
    return listDashboardPanels(panels)
        .map((e) => e.title)
        .filter(Boolean);
}

export async function verifyLlmDashboardSave(
    mcpClient: McpClient | null | undefined,
    userMessage: string,
    toolExecutions: ToolExecution[],
    contextDashboardUid?: string
): Promise<LlmSaveVerification> {
    if (!mcpClient || !hasSuccessfulDashboardSave(toolExecutions)) {
        return { verified: false, skipped: true };
    }

    const uid =
        savedUidFromTools(toolExecutions) ??
        extractDashboardUidFromMessage(userMessage) ??
        contextDashboardUid ??
        getTurnDashboardBaseline()?.uid;

    if (!uid) {
        return {
            verified: false,
            skipped: false,
            detail: 'update_dashboard succeeded but dashboard uid could not be resolved for verification.',
        };
    }

    const fetch = await callMcpTool(mcpClient, 'get_dashboard_by_uid', { uid });
    if (!fetch.ok) {
        return {
            verified: false,
            skipped: false,
            uid,
            detail: fetch.error ?? 'Could not re-fetch dashboard after save.',
        };
    }

    const extracted = extractDashboardFromGetByUid(fetch.text);
    if (!extracted?.dashboard) {
        return {
            verified: false,
            skipped: false,
            uid,
            detail: 'Could not parse dashboard JSON after save.',
        };
    }

    const currentTitles = panelTitlesFromDashboard(extracted.dashboard.panels);
    const currentCount = currentTitles.length;
    const version =
        typeof extracted.dashboard.version === 'number'
            ? extracted.dashboard.version
            : parseInt(savedVersionFromTools(toolExecutions) ?? '', 10) || undefined;
    const baseline = getTurnDashboardBaseline();

    const removeReq = parsePanelRemoveRequest(userMessage, { contextDashboardUid: contextDashboardUid ?? uid });
    if (removeReq) {
        const stillThere = findPanelForRemoval(listDashboardPanels(extracted.dashboard.panels), removeReq.panelTitle);
        if (stillThere) {
            return {
                verified: false,
                skipped: false,
                uid,
                version,
                baselinePanelCount: baseline?.panelCount,
                currentPanelCount: currentCount,
                detail: `Panel **${stillThere.title}** is still on the dashboard after save.`,
            };
        }
        return {
            verified: true,
            skipped: false,
            uid,
            version,
            baselinePanelCount: baseline?.panelCount,
            currentPanelCount: currentCount,
            detail: `Panel **${removeReq.panelTitle}** removed (verified).`,
        };
    }

    const renameReq = parsePanelRenameRequest(userMessage);
    if (renameReq && renameReq.dashboardUid === uid) {
        const hasNew = currentTitles.some(
            (t) => t.toLowerCase() === renameReq.newPanelTitle.toLowerCase()
        );
        if (!hasNew) {
            return {
                verified: false,
                skipped: false,
                uid,
                version,
                detail: `Panel title **${renameReq.newPanelTitle}** not found after save.`,
            };
        }
        return {
            verified: true,
            skipped: false,
            uid,
            version,
            detail: `Panel renamed to **${renameReq.newPanelTitle}** (verified).`,
        };
    }

    const savedVersion = parseInt(savedVersionFromTools(toolExecutions) ?? '', 10);
    if (baseline?.version != null && version != null && version < baseline.version) {
        return {
            verified: false,
            skipped: false,
            uid,
            version,
            detail: `Dashboard version did not advance (was ${baseline.version}, now ${version}).`,
        };
    }

    if (baseline && currentCount === baseline.panelCount && /\b(remove|delete)\b/i.test(userMessage)) {
        return {
            verified: false,
            skipped: false,
            uid,
            version,
            baselinePanelCount: baseline.panelCount,
            currentPanelCount: currentCount,
            detail: 'Panel count unchanged after a remove/delete request.',
        };
    }

    return {
        verified: true,
        skipped: false,
        uid,
        version,
        baselinePanelCount: baseline?.panelCount,
        currentPanelCount: currentCount,
        detail:
            baseline != null
                ? `Dashboard saved (version ${(version ?? savedVersion) || '?'}, ${currentCount} panels).`
                : `Dashboard saved (version ${(version ?? savedVersion) || '?'}).`,
    };
}
