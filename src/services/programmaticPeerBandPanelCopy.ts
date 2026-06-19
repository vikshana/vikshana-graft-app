import type { ToolExecution } from '../types/llm.types';
import {
    countPanelsInDashboard,
    extractDashboardFromGetByUid,
    replaceMachineLabelsInValue,
} from './programmaticDashboardClone';
import { callMcpTool } from './mcpToolClient';
import type { McpClient } from './dashboardChunkedUpdate';
import { saveDashboardInPanelChunks } from './dashboardChunkedUpdate';
import { applyFluxFixesToPanel, stampDashboardForOverwrite } from './fluxQueryFix';
import { listDashboardPanels, findPeerBandPanels, type DashboardPanelEntry } from './panelDiscovery';
import { replacePanelAtPath, replacePanelInDashboard, type ScopedPanelFixTarget } from './panelFixScope';
import { normalizeUpdateDashboardArgs } from './updateDashboardArgs';
import {
    findReferenceFluxPeerBandPanel,
    isHistoryComparisonPanel,
    panelPeerBandTargetsStillStale,
} from './fluxPeerBandFix';
import { formatPanelTargetLabel } from './panelDiscovery';
import { scanPanelFluxIssues } from './panelFluxVerification';
import type { PeerBandPanelCopyRequest } from './peerBandPanelCopyParse';
import { isMachineId, MACHINE_ID_PATTERN } from './dashboardCloneParse';

type PanelRecord = Record<string, unknown>;

export interface CopiedPeerBandPanelResult {
    sourceTitle: string;
    action: 'replaced' | 'appended' | 'skipped';
    targetsFixed: number;
    staleAfterFix: boolean;
}

export interface TargetPeerBandCopyResult {
    targetUid: string;
    targetTitle?: string;
    ok: boolean;
    error?: string;
    sourceMachine: string;
    targetMachine: string;
    panelsCopied: number;
    panelsReplaced: number;
    panelsAppended: number;
    targetsFixed: number;
    panelResults: CopiedPeerBandPanelResult[];
    verificationNote?: string;
}

export interface ProgrammaticPeerBandPanelCopyResult {
    ok: boolean;
    error?: string;
    toolExecutions: ToolExecution[];
    sourcePanelsMatched: number;
    targetResults: TargetPeerBandCopyResult[];
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

export function inferMachineIdFromDashboardTitle(title: string): string | undefined {
    const head = title.split('/')[0]?.trim() ?? title.trim();
    const lead = head.match(new RegExp(`^(${MACHINE_ID_PATTERN.source})$`))?.[1];
    if (lead && isMachineId(lead)) {
        return lead;
    }
    for (const m of title.matchAll(new RegExp(MACHINE_ID_PATTERN.source, 'g'))) {
        if (m[0] && isMachineId(m[0])) {
            return m[0];
        }
    }
    return undefined;
}

function normalizeTitle(title: string): string {
    return title.trim().toLowerCase();
}

function findPanelByExactTitle(
    entries: DashboardPanelEntry[],
    title: string
): DashboardPanelEntry | undefined {
    const want = normalizeTitle(title);
    return entries.find((e) => normalizeTitle(e.title) === want);
}

function maxPanelId(entries: DashboardPanelEntry[]): number {
    let max = 0;
    for (const e of entries) {
        if (e.panelId != null && e.panelId > max) {
            max = e.panelId;
        }
    }
    return max;
}

function computeAppendGridPos(entries: DashboardPanelEntry[], panel: PanelRecord): { x: number; y: number; w: number; h: number } {
    const defaultW = 12;
    const defaultH = 8;
    let maxY = 0;
    for (const e of entries) {
        const gp = e.panel.gridPos as { y?: number; h?: number } | undefined;
        if (gp && typeof gp.y === 'number' && typeof gp.h === 'number') {
            maxY = Math.max(maxY, gp.y + gp.h);
        }
    }
    const srcGp = panel.gridPos as { w?: number; h?: number } | undefined;
    return {
        x: 0,
        y: maxY,
        w: typeof srcGp?.w === 'number' ? srcGp.w : defaultW,
        h: typeof srcGp?.h === 'number' ? srcGp.h : defaultH,
    };
}

function preparePanelForCopy(panel: PanelRecord, newPanelId: number): PanelRecord {
    const copy = JSON.parse(JSON.stringify(panel)) as PanelRecord;
    copy.id = newPanelId;
    return copy;
}

function appendPanelToDashboard(
    dashboard: Record<string, unknown>,
    panel: PanelRecord,
    entries: DashboardPanelEntry[]
): void {
    const panels = dashboard.panels;
    const nextPanel = { ...panel, gridPos: computeAppendGridPos(entries, panel) };
    if (!Array.isArray(panels)) {
        dashboard.panels = [nextPanel];
        return;
    }
    panels.push(nextPanel);
}

function scopeForEntry(entry: DashboardPanelEntry, dashboardUid: string): ScopedPanelFixTarget {
    return {
        dashboardUid,
        panelId: entry.panelId,
        panelTitle: entry.title,
        panelArrayIndex: entry.arrayIndex,
    };
}

function resolveMachinesForTarget(
    request: PeerBandPanelCopyRequest,
    sourceTitle: string | undefined,
    targetTitle: string | undefined,
    targetUid: string
): { sourceMachine: string; targetMachine: string } | { error: string } {
    const sourceMachine =
        request.sourceMachineId ?? inferMachineIdFromDashboardTitle(sourceTitle ?? '') ?? undefined;
    const targetMachine =
        request.targetMachineByUid?.[targetUid] ??
        request.targetMachineId ??
        inferMachineIdFromDashboardTitle(targetTitle ?? '') ??
        undefined;

    if (!sourceMachine || !isMachineId(sourceMachine)) {
        return {
            error:
                'Could not infer source machine id. Add it in your message (e.g. copy from 2406-176021) or use a dashboard title like "2406-176021 / Exsolve".',
        };
    }
    if (!targetMachine || !isMachineId(targetMachine)) {
        return {
            error:
                `Could not infer target machine id for dashboard uid \`${targetUid}\`. ` +
                'Add "with data for MACHINE" or a per-target machine id in your message.',
        };
    }
    return { sourceMachine, targetMachine };
}

function mergePeerBandPanelsIntoTarget(
    baseline: Record<string, unknown>,
    sourceEntries: DashboardPanelEntry[],
    targetUid: string,
    sourceMachine: string,
    targetMachine: string,
    replaceExisting: boolean,
    reference?: { panel: PanelRecord; targetA: PanelRecord }
): {
    proposed: Record<string, unknown>;
    panelResults: CopiedPeerBandPanelResult[];
    panelsCopied: number;
    panelsReplaced: number;
    panelsAppended: number;
    targetsFixed: number;
} {
    const proposed = JSON.parse(JSON.stringify(baseline)) as Record<string, unknown>;
    const dashboardTitle = typeof baseline.title === 'string' ? baseline.title : undefined;
    const panelResults: CopiedPeerBandPanelResult[] = [];
    let panelsCopied = 0;
    let panelsReplaced = 0;
    let panelsAppended = 0;
    let targetsFixed = 0;

    let entries = listDashboardPanels(proposed.panels);
    let nextId = maxPanelId(entries) + 1;
    const targetReference =
        reference ??
        findReferenceFluxPeerBandPanel(entries.map((e) => e.panel).concat(sourceEntries.map((e) => e.panel)));

    for (const sourceEntry of sourceEntries) {
        entries = listDashboardPanels(proposed.panels);

        if (isHistoryComparisonPanel(sourceEntry.panel)) {
            panelResults.push({
                sourceTitle: sourceEntry.title,
                action: 'skipped',
                targetsFixed: 0,
                staleAfterFix: false,
            });
            continue;
        }

        const remapped = replaceMachineLabelsInValue(
            JSON.parse(JSON.stringify(sourceEntry.panel)),
            sourceMachine,
            targetMachine
        ) as PanelRecord;

        const title = typeof remapped.title === 'string' ? remapped.title : sourceEntry.title;
        const existing = findPanelByExactTitle(entries, title);

        let action: 'replaced' | 'appended';

        if (existing && replaceExisting) {
            const scope = scopeForEntry(existing, targetUid);
            const { panel: fixedPanel, targetsFixed: fixedCount } = applyFluxFixesToPanel(remapped, {
                aggressive: true,
                dashboardTitle,
                referenceTarget: targetReference?.targetA,
                referencePanel: targetReference?.panel,
            });
            const staleAfterFix = panelPeerBandTargetsStillStale(fixedPanel);
            const replaced =
                replacePanelAtPath(proposed, existing.path, fixedPanel) ||
                replacePanelInDashboard(proposed, scope, fixedPanel);
            if (!replaced) {
                panelResults.push({
                    sourceTitle: title,
                    action: 'skipped',
                    targetsFixed: 0,
                    staleAfterFix: true,
                });
                continue;
            }
            panelsReplaced += 1;
            panelsCopied += 1;
            targetsFixed += fixedCount;
            action = 'replaced';
            panelResults.push({
                sourceTitle: title,
                action,
                targetsFixed: fixedCount,
                staleAfterFix,
            });
        } else if (!existing) {
            const prepared = preparePanelForCopy(remapped, nextId++);
            const { panel: fixedPanel, targetsFixed: fixedCount } = applyFluxFixesToPanel(prepared, {
                aggressive: true,
                dashboardTitle,
                referenceTarget: targetReference?.targetA,
                referencePanel: targetReference?.panel,
            });
            const staleAfterFix = panelPeerBandTargetsStillStale(fixedPanel);
            entries = listDashboardPanels(proposed.panels);
            appendPanelToDashboard(proposed, fixedPanel, entries);
            entries = listDashboardPanels(proposed.panels);
            panelsAppended += 1;
            panelsCopied += 1;
            targetsFixed += fixedCount;
            action = 'appended';
            panelResults.push({
                sourceTitle: title,
                action,
                targetsFixed: fixedCount,
                staleAfterFix,
            });
        } else {
            panelResults.push({
                sourceTitle: title,
                action: 'skipped',
                targetsFixed: 0,
                staleAfterFix: false,
            });
            continue;
        }
    }

    return {
        proposed,
        panelResults,
        panelsCopied,
        panelsReplaced,
        panelsAppended,
        targetsFixed,
    };
}

async function saveTargetDashboard(
    mcpClient: McpClient,
    baseline: Record<string, unknown>,
    proposed: Record<string, unknown>,
    targetUid: string,
    toolExecutions: ToolExecution[],
    message: string,
    folderUid?: string
): Promise<{ ok: boolean; error?: string }> {
    const panelCount = countPanelsInDashboard(proposed);
    const useChunks = panelCount > 24;

    if (useChunks) {
        const chunked = await saveDashboardInPanelChunks(
            mcpClient,
            stampDashboardForOverwrite(baseline, proposed),
            {
                targetUid,
                folderUid,
                overwrite: true,
                messagePrefix: message,
            },
            toolExecutions
        );
        return { ok: chunked.ok, error: chunked.error };
    }

    const saveStep = pendingTool('update_dashboard');
    toolExecutions.push(saveStep);
    const savePayload = normalizeUpdateDashboardArgs({
        dashboard: stampDashboardForOverwrite(baseline, proposed),
        overwrite: true,
        message,
    });
    const saveResult = await callMcpTool(mcpClient, 'update_dashboard', savePayload);
    toolExecutions[toolExecutions.length - 1] = finishTool(saveStep, saveResult);
    return { ok: saveResult.ok, error: saveResult.error };
}

export async function runProgrammaticPeerBandPanelCopy(
    mcpClient: McpClient,
    request: PeerBandPanelCopyRequest
): Promise<ProgrammaticPeerBandPanelCopyResult> {
    const toolExecutions: ToolExecution[] = [];

    const getSourceStep = pendingTool('get_dashboard_by_uid');
    toolExecutions.push(getSourceStep);
    const sourceFetch = await callMcpTool(mcpClient, 'get_dashboard_by_uid', {
        uid: request.sourceDashboardUid,
    });
    toolExecutions[toolExecutions.length - 1] = finishTool(getSourceStep, sourceFetch);

    if (!sourceFetch.ok) {
        return {
            ok: false,
            error: sourceFetch.error ?? 'Could not load source dashboard',
            toolExecutions,
            sourcePanelsMatched: 0,
            targetResults: [],
        };
    }

    const sourceExtracted = extractDashboardFromGetByUid(sourceFetch.text);
    if (!sourceExtracted?.dashboard) {
        return {
            ok: false,
            error: 'Could not parse source dashboard JSON',
            toolExecutions,
            sourcePanelsMatched: 0,
            targetResults: [],
        };
    }

    const sourceDashboard = sourceExtracted.dashboard;
    const sourceTitle = typeof sourceDashboard.title === 'string' ? sourceDashboard.title : undefined;
    const sourceEntries = findPeerBandPanels(
        listDashboardPanels(sourceDashboard.panels),
        request.titleContains
    );

    if (sourceEntries.length === 0) {
        return {
            ok: false,
            error:
                `No panels on source dashboard uid \`${request.sourceDashboardUid}\` matched title containing "${request.titleContains}".`,
            toolExecutions,
            sourcePanelsMatched: 0,
            targetResults: [],
        };
    }

    const sourceReference = findReferenceFluxPeerBandPanel(
        sourceEntries
            .map((e) => e.panel)
            .concat(listDashboardPanels(sourceDashboard.panels).map((e) => e.panel))
    );

    const targetResults: TargetPeerBandCopyResult[] = [];
    let allOk = true;

    for (const targetUid of request.targetDashboardUids) {
        const getTargetStep = pendingTool('get_dashboard_by_uid');
        toolExecutions.push(getTargetStep);
        const targetFetch = await callMcpTool(mcpClient, 'get_dashboard_by_uid', { uid: targetUid });
        toolExecutions[toolExecutions.length - 1] = finishTool(getTargetStep, targetFetch);

        if (!targetFetch.ok) {
            allOk = false;
            targetResults.push({
                targetUid,
                ok: false,
                error: targetFetch.error ?? 'Could not load target dashboard',
                sourceMachine: '',
                targetMachine: '',
                panelsCopied: 0,
                panelsReplaced: 0,
                panelsAppended: 0,
                targetsFixed: 0,
                panelResults: [],
            });
            continue;
        }

        const targetExtracted = extractDashboardFromGetByUid(targetFetch.text);
        if (!targetExtracted?.dashboard) {
            allOk = false;
            targetResults.push({
                targetUid,
                ok: false,
                error: 'Could not parse target dashboard JSON',
                sourceMachine: '',
                targetMachine: '',
                panelsCopied: 0,
                panelsReplaced: 0,
                panelsAppended: 0,
                targetsFixed: 0,
                panelResults: [],
            });
            continue;
        }

        const targetDashboard = targetExtracted.dashboard;
        const targetTitle = typeof targetDashboard.title === 'string' ? targetDashboard.title : undefined;
        const machines = resolveMachinesForTarget(request, sourceTitle, targetTitle, targetUid);
        if ('error' in machines) {
            allOk = false;
            targetResults.push({
                targetUid,
                targetTitle,
                ok: false,
                error: machines.error,
                sourceMachine: '',
                targetMachine: '',
                panelsCopied: 0,
                panelsReplaced: 0,
                panelsAppended: 0,
                targetsFixed: 0,
                panelResults: [],
            });
            continue;
        }

        const { proposed, panelResults, panelsCopied, panelsReplaced, panelsAppended, targetsFixed } =
            mergePeerBandPanelsIntoTarget(
                targetDashboard,
                sourceEntries,
                targetUid,
                machines.sourceMachine,
                machines.targetMachine,
                request.replaceExisting,
                sourceReference
            );

        if (panelsCopied === 0) {
            allOk = false;
            targetResults.push({
                targetUid,
                targetTitle,
                ok: false,
                error: 'No panels were copied or replaced on this dashboard.',
                sourceMachine: machines.sourceMachine,
                targetMachine: machines.targetMachine,
                panelsCopied: 0,
                panelsReplaced,
                panelsAppended,
                targetsFixed,
                panelResults,
            });
            continue;
        }

        const stale = panelResults.filter((r) => r.staleAfterFix);
        const folderUid =
            typeof targetExtracted.meta?.folderUid === 'string' ? targetExtracted.meta.folderUid : undefined;

        const save = await saveTargetDashboard(
            mcpClient,
            targetDashboard,
            proposed,
            targetUid,
            toolExecutions,
            `Graft: copy peer-band panels ${machines.sourceMachine} → ${machines.targetMachine}`,
            folderUid
        );

        if (!save.ok) {
            allOk = false;
            targetResults.push({
                targetUid,
                targetTitle,
                ok: false,
                error: save.error ?? 'update_dashboard failed',
                sourceMachine: machines.sourceMachine,
                targetMachine: machines.targetMachine,
                panelsCopied,
                panelsReplaced,
                panelsAppended,
                targetsFixed,
                panelResults,
            });
            continue;
        }

        const verifyStep = pendingTool('get_dashboard_by_uid');
        toolExecutions.push(verifyStep);
        const verifyFetch = await callMcpTool(mcpClient, 'get_dashboard_by_uid', { uid: targetUid });
        toolExecutions[toolExecutions.length - 1] = finishTool(verifyStep, verifyFetch);

        let verificationNote = `Copied **${panelsCopied}** panel(s) (${panelsReplaced} replaced, ${panelsAppended} appended).`;
        if (verifyFetch.ok) {
            const verified = extractDashboardFromGetByUid(verifyFetch.text);
            const verifiedEntries = verified?.dashboard
                ? findPeerBandPanels(listDashboardPanels(verified.dashboard.panels), request.titleContains)
                : [];
            const staleAfterSave = verifiedEntries.filter((e) => panelPeerBandTargetsStillStale(e.panel));
            if (staleAfterSave.length > 0) {
                verificationNote += ` **Still stale:** ${staleAfterSave.map((e) => e.title).join('; ')}`;
                allOk = false;
            } else if (request.verifyAfterSave) {
                const issueLines: string[] = [];
                for (const entry of verifiedEntries) {
                    const issues = scanPanelFluxIssues(entry.panel);
                    if (issues.length > 0) {
                        issueLines.push(
                            `${formatPanelTargetLabel(entry)}: ${issues.map((i) => i.issue).join('; ')}`
                        );
                    }
                }
                if (issueLines.length > 0) {
                    verificationNote += ` **Verification found issues:**\n${issueLines.map((l) => `  - ${l}`).join('\n')}`;
                    allOk = false;
                } else {
                    verificationNote += ` **Verification:** all **${verifiedEntries.length}** "${request.titleContains}" panel(s) on \`${targetUid}\` passed static Flux checks.`;
                }
            } else {
                verificationNote += ' All copied panels passed static Flux checks.';
            }
        } else if (request.verifyAfterSave) {
            verificationNote += ' Could not re-load the target dashboard to verify.';
            allOk = false;
        }

        if (stale.length > 0) {
            allOk = false;
        }

        targetResults.push({
            targetUid,
            targetTitle,
            ok: stale.length === 0 && save.ok,
            sourceMachine: machines.sourceMachine,
            targetMachine: machines.targetMachine,
            panelsCopied,
            panelsReplaced,
            panelsAppended,
            targetsFixed,
            panelResults,
            verificationNote,
            error:
                stale.length > 0
                    ? `${stale.length} copied panel(s) still fail peer-band static checks.`
                    : undefined,
        });
    }

    if (targetResults.length === 0) {
        return {
            ok: false,
            error: 'No target dashboards were processed.',
            toolExecutions,
            sourcePanelsMatched: sourceEntries.length,
            targetResults,
        };
    }

    const anySuccess = targetResults.some((r) => r.ok);
    return {
        ok: allOk && anySuccess,
        error: allOk
            ? undefined
            : targetResults
                  .filter((r) => !r.ok)
                  .map((r) => `\`${r.targetUid}\`: ${r.error ?? 'failed'}`)
                  .join('\n'),
        toolExecutions,
        sourcePanelsMatched: sourceEntries.length,
        targetResults,
    };
}

export function formatPeerBandPanelCopyReply(result: ProgrammaticPeerBandPanelCopyResult, buildNumber: number): string {
    const lines = result.targetResults.map((r) => {
        if (r.ok) {
            return (
                `- **${r.targetTitle ?? r.targetUid}** (\`${r.targetUid}\`): ` +
                `${r.panelsCopied} panel(s) (${r.panelsReplaced} replaced, ${r.panelsAppended} appended), ` +
                `${r.targetsFixed} queries — ${r.sourceMachine} → ${r.targetMachine}` +
                (r.verificationNote ? `\n  ${r.verificationNote}` : '')
            );
        }
        return `- **${r.targetTitle ?? r.targetUid}** (\`${r.targetUid}\`): failed — ${r.error ?? 'unknown error'}`;
    });

    const header = result.ok
        ? `### Peer-band panels copied (Graft build ${buildNumber})`
        : `### Peer-band panel copy — partial or failed (Graft build ${buildNumber})`;

    return (
        `${header}\n\n` +
        `**Source:** ${result.sourcePanelsMatched} panel(s) matched.\n\n` +
        `${lines.join('\n')}` +
        (result.error && !result.ok ? `\n\n${result.error}` : '')
    );
}
