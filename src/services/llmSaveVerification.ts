import type { ToolExecution } from '../types/llm.types';
import type { McpClient } from './dashboardChunkedUpdate';
import { callMcpTool } from './mcpToolClient';
import { extractDashboardFromGetByUid } from './programmaticDashboardClone';
import { extractAllDashboardUids, extractDashboardUidFromMessage } from './dashboardMentionParse';
import { findPanelForRemoval, listDashboardPanels } from './panelDiscovery';
import { getTurnDashboardBaseline } from './llmDashboardSnapshot';
import { parsePanelCreateRequest } from './panelCreateParse';
import { parsePanelRemoveRequest } from './panelRemoveParse';
import { parsePanelRenameRequest } from './panelRenameParse';
import { messageDescribesAmbiguousGraphCreate } from './ambiguousGraphCreateParse';
import { findPanelByStrictTitle } from './panelDiscovery';
import { savedUidFromTools, savedVersionFromTools } from './dashboardSaveReplyUtils';
import { hasSuccessfulDashboardSave } from './continueAction';
import { userWantsPanelCreate } from './dashboardPanelCreateReply';
import { messageMentionsPredictiveAnalyticsPanel, parseAddHistoryComparisonPanelRequest } from './historyComparisonPanelAddParse';
import { parseAddPeerBandPanelRequest } from './peerBandPanelAddParse';
import { formatHistoryComparisonOutcomeMismatch } from './programmaticIntentRouter';
import { isLiveHistoryComparisonPanel } from './modulePanelTitles';

export interface LlmSaveVerification {
    verified: boolean;
    skipped: boolean;
    uid?: string;
    version?: number;
    detail?: string;
    /** Full assistant reply when save succeeded but the wrong panel type/title was observed. */
    routingMismatchReply?: string;
    baselinePanelCount?: number;
    currentPanelCount?: number;
}

function panelTitlesFromDashboard(panels: unknown): string[] {
    return listDashboardPanels(panels)
        .map((e) => e.title)
        .filter(Boolean);
}

function newHistoryComparisonPanels(baselineTitles: string[] | undefined, currentTitles: string[]): string[] {
    const baselineSet = new Set((baselineTitles ?? []).map((t) => t.toLowerCase()));
    return currentTitles.filter(
        (t) => !baselineSet.has(t.toLowerCase()) && isLiveHistoryComparisonPanel(t)
    );
}

function routingMismatchFromObservedPanel(
    userMessage: string,
    observedPanelTitle: string | undefined,
    buildNumber: string | number
): string | undefined {
    if (!observedPanelTitle) {
        return undefined;
    }
    return formatHistoryComparisonOutcomeMismatch(userMessage, observedPanelTitle, Number(buildNumber)) ?? undefined;
}

export async function verifyLlmDashboardSave(
    mcpClient: McpClient | null | undefined,
    userMessage: string,
    toolExecutions: ToolExecution[],
    contextDashboardUid?: string,
    buildNumber: string | number = 0
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
    const baselineTitles = baseline?.panelTitles;

    const hcReq = parseAddHistoryComparisonPanelRequest(userMessage);
    if (hcReq?.signal?.panelTitle) {
        const expected = hcReq.signal.panelTitle;
        const hasExpected = currentTitles.some((t) => t.toLowerCase() === expected.toLowerCase());
        if (!hasExpected) {
            const observed = newHistoryComparisonPanels(baselineTitles, currentTitles)[0];
            if (observed) {
                const routingMismatchReply = routingMismatchFromObservedPanel(
                    userMessage,
                    observed,
                    buildNumber
                );
                if (routingMismatchReply) {
                    return {
                        verified: false,
                        skipped: false,
                        uid,
                        version,
                        routingMismatchReply,
                        baselinePanelCount: baseline?.panelCount,
                        currentPanelCount: currentCount,
                        detail: `Expected panel **${expected}** but observed **${observed}**.`,
                    };
                }
            }
        }
    }

    const peerReq = parseAddPeerBandPanelRequest(userMessage);
    if (peerReq) {
        const observed = newHistoryComparisonPanels(baselineTitles, currentTitles)[0];
        const routingMismatchReply = routingMismatchFromObservedPanel(
            userMessage,
            observed,
            buildNumber
        );
        if (routingMismatchReply) {
            return {
                verified: false,
                skipped: false,
                uid,
                version,
                routingMismatchReply,
                baselinePanelCount: baseline?.panelCount,
                currentPanelCount: currentCount,
                detail: `Peer Band create observed History Comparison panel **${observed}**.`,
            };
        }
    }

    const createReq = parsePanelCreateRequest(userMessage, { contextDashboardUid: contextDashboardUid ?? uid });
    if (createReq) {
        const created = findPanelByStrictTitle(
            listDashboardPanels(extracted.dashboard.panels),
            createReq.panelTitle
        );
        if (!created) {
            return {
                verified: false,
                skipped: false,
                uid,
                version,
                baselinePanelCount: baseline?.panelCount,
                currentPanelCount: currentCount,
                detail: `Panel **${createReq.panelTitle}** was not found after save.`,
            };
        }
        return {
            verified: true,
            skipped: false,
            uid,
            version,
            baselinePanelCount: baseline?.panelCount,
            currentPanelCount: currentCount,
            detail: `Panel **${createReq.panelTitle}** created (verified, id ${created.panelId ?? '?'}).`,
        };
    }

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
    const requestedUids = extractAllDashboardUids(userMessage);
    if (requestedUids.length === 1 && uid && requestedUids[0] !== uid) {
        return {
            verified: false,
            skipped: false,
            uid,
            version,
            detail:
                `Prompt specified dashboard uid \`${requestedUids[0]}\` but the save targeted \`${uid}\`. ` +
                'Retry with the programmatic panel-rename fast path or verify the uid in Grafana.',
        };
    }
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

    if (
        messageDescribesAmbiguousGraphCreate(userMessage, contextDashboardUid) &&
        baseline &&
        currentCount <= baseline.panelCount
    ) {
        return {
            verified: false,
            skipped: false,
            uid,
            version,
            baselinePanelCount: baseline.panelCount,
            currentPanelCount: currentCount,
            detail:
                'No new panels were added after a vague graph/chart create request. ' +
                'Use a specific programmatic prompt (typed panels, bulk metrics, or row + panels).',
        };
    }

    if (
        userWantsPanelCreate(userMessage) &&
        !createReq &&
        baseline &&
        currentCount <= baseline.panelCount
    ) {
        return {
            verified: false,
            skipped: false,
            uid,
            version,
            baselinePanelCount: baseline.panelCount,
            currentPanelCount: currentCount,
            detail:
                'Dashboard version advanced but no new panel was added. ' +
                (messageMentionsPredictiveAnalyticsPanel(userMessage)
                    ? 'Use the predictive analytics / History Comparison fast path (include module number and dashboard uid).'
                    : 'Retry with a named panel title or a supported programmatic create prompt.'),
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
