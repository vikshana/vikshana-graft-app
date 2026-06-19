import type { ToolExecution } from '../types/llm.types';
import { callMcpTool, parseJsonFromMcpText } from './mcpToolClient';
import { DEFAULT_PANEL_CHUNK_SIZE, splitPanelsIntoChunks } from './dashboardCloneChunks';
import { evaluateMcpToolResult, formatToolResultForLlm } from './toolResult';
import { applyPanelFixScopeEnforcement } from './panelFixEnforcement';
import { getPanelFixScope } from './panelFixSessionStorage';

export type McpClient = {
    callTool: (req: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>;
};

export interface PatchOperation {
    op: string;
    path: string;
    value?: unknown;
}

export interface PanelChunkSaveOptions {
    folderUid?: string;
    targetUid?: string;
    overwrite?: boolean;
    messagePrefix?: string;
    startChunkIndex?: number;
    resumeTargetUid?: string;
    onChunkSaved?: (info: { chunkIndex: number; totalChunks: number; uid?: string }) => void;
}

export interface ChunkedUpdateResult {
    ok: boolean;
    error?: string;
    text: string;
    summary?: string;
    userReference?: string;
    chunksSaved: number;
    totalChunks: number;
    uid?: string;
}

export interface ChunkedUpdateHooks {
    /** Called for each MCP batch (including the first). */
    onChunkToolStep?: (step: ToolExecution, chunkIndex: number, totalChunks: number) => void;
}

function pendingTool(name: string): ToolExecution {
    return { name, status: 'pending' };
}

function finishTool(
    step: ToolExecution,
    outcome: { ok: boolean; error?: string; summary?: string; userReference?: string }
): ToolExecution {
    return {
        ...step,
        status: outcome.ok ? 'success' : 'error',
        error: outcome.error,
        summary: outcome.summary,
        userReference: outcome.userReference,
    };
}

function parseSaveResponse(
    save: { ok: boolean; text: string; summary?: string },
    fallbackUid?: string
): { uid?: string; version?: number } {
    let uid = fallbackUid;
    let version: number | undefined;
    const savedParsed = parseJsonFromMcpText(save.text);
    if (savedParsed && typeof savedParsed === 'object') {
        const obj = savedParsed as Record<string, unknown>;
        if (typeof obj.uid === 'string') {
            uid = obj.uid;
        }
        if (typeof obj.version === 'number') {
            version = obj.version;
        }
    }
    if (save.summary) {
        uid = save.summary.match(/uid=([^\s,]+)/)?.[1] ?? uid;
        const verMatch = save.summary.match(/version=(\d+)/);
        if (verMatch) {
            version = Number(verMatch[1]);
        }
    }
    return { uid, version };
}

export function topLevelPanelSlotCount(dashboard: Record<string, unknown>): number {
    const panels = dashboard.panels;
    return Array.isArray(panels) ? panels.length : 0;
}

export function shouldChunkFullDashboard(
    dashboard: Record<string, unknown>,
    chunkSize = DEFAULT_PANEL_CHUNK_SIZE
): boolean {
    return topLevelPanelSlotCount(dashboard) > chunkSize;
}

export function isPanelAppendOperation(op: PatchOperation): boolean {
    if (op.op !== 'add' || typeof op.path !== 'string') {
        return false;
    }
    const path = op.path.trim();
    return path === '$.panels/-' || path === '$.panels/- ';
}

export function shouldChunkUpdateDashboardArgs(
    args: Record<string, unknown>,
    chunkSize = DEFAULT_PANEL_CHUNK_SIZE
): boolean {
    if (getPanelFixScope()) {
        return false;
    }
    const dashboard = args.dashboard;
    if (dashboard && typeof dashboard === 'object' && !Array.isArray(dashboard)) {
        if (shouldChunkFullDashboard(dashboard as Record<string, unknown>, chunkSize)) {
            return true;
        }
    }

    const operations = args.operations;
    if (Array.isArray(operations) && typeof args.uid === 'string') {
        const panelAppends = operations.filter(
            (op) => op && typeof op === 'object' && isPanelAppendOperation(op as PatchOperation)
        );
        return panelAppends.length > chunkSize;
    }

    return false;
}

async function saveDashboardFullJson(
    mcpClient: McpClient,
    dashboard: Record<string, unknown>,
    opts: { folderUid?: string; overwrite: boolean; message: string },
    toolExecutions?: ToolExecution[],
    hooks?: ChunkedUpdateHooks,
    chunkIndex = 0,
    totalChunks = 1
): Promise<{ ok: boolean; error?: string; uid?: string; text: string; summary?: string }> {
    const saveStep = pendingTool('update_dashboard');
    if (toolExecutions) {
        toolExecutions.push(saveStep);
    }
    hooks?.onChunkToolStep?.(saveStep, chunkIndex, totalChunks);

    const saveArgs: Record<string, unknown> = {
        dashboard,
        message: opts.message,
        overwrite: opts.overwrite,
    };
    if (opts.folderUid) {
        saveArgs.folderUid = opts.folderUid;
    }

    const save = await callMcpTool(mcpClient, 'update_dashboard', saveArgs);
    const finished = finishTool(saveStep, save);
    if (toolExecutions?.length) {
        toolExecutions[toolExecutions.length - 1] = finished;
    }
    hooks?.onChunkToolStep?.(finished, chunkIndex, totalChunks);

    if (!save.ok) {
        return { ok: false, error: save.error ?? 'update_dashboard failed', text: save.text };
    }
    const parsed = parseSaveResponse(save);
    return {
        ok: true,
        uid: parsed.uid,
        text: save.text,
        summary: save.summary ?? `Saved dashboard uid=${parsed.uid ?? '?'}`,
    };
}

async function appendPanelChunk(
    mcpClient: McpClient,
    targetUid: string,
    panels: unknown[],
    opts: { message: string; folderUid?: string; userId?: number },
    toolExecutions?: ToolExecution[],
    hooks?: ChunkedUpdateHooks,
    chunkIndex = 0,
    totalChunks = 1
): Promise<{ ok: boolean; error?: string; text: string; summary?: string }> {
    const operations = panels.map((panel) => ({
        op: 'add',
        path: '$.panels/-',
        value: panel,
    }));

    const saveStep = pendingTool('update_dashboard');
    if (toolExecutions) {
        toolExecutions.push(saveStep);
    }
    hooks?.onChunkToolStep?.(saveStep, chunkIndex, totalChunks);

    const saveArgs: Record<string, unknown> = {
        uid: targetUid,
        operations,
        message: opts.message,
    };
    if (opts.folderUid) {
        saveArgs.folderUid = opts.folderUid;
    }
    if (opts.userId != null) {
        saveArgs.userId = opts.userId;
    }

    const save = await callMcpTool(mcpClient, 'update_dashboard', saveArgs);
    const finished = finishTool(saveStep, save);
    if (toolExecutions?.length) {
        toolExecutions[toolExecutions.length - 1] = finished;
    }
    hooks?.onChunkToolStep?.(finished, chunkIndex, totalChunks);

    if (!save.ok) {
        return { ok: false, error: save.error ?? 'update_dashboard patch failed', text: save.text };
    }
    return {
        ok: true,
        text: save.text,
        summary: save.summary ?? `Patched dashboard uid=${targetUid}`,
    };
}

async function executePatchPanelChunks(
    mcpClient: McpClient,
    args: Record<string, unknown>,
    toolExecutions?: ToolExecution[],
    hooks?: ChunkedUpdateHooks
): Promise<ChunkedUpdateResult> {
    const uid = String(args.uid);
    const allOps = (args.operations as PatchOperation[]) ?? [];
    const panelAppends = allOps.filter(isPanelAppendOperation);
    const otherOps = allOps.filter((op) => !isPanelAppendOperation(op));
    const chunks = splitPanelsIntoChunks(
        panelAppends.map((op) => op.value),
        DEFAULT_PANEL_CHUNK_SIZE
    );
    const totalChunks = chunks.length;
    const prefix =
        typeof args.message === 'string' && args.message.trim()
            ? args.message.trim()
            : 'Graft panel batch';
    const folderUid = typeof args.folderUid === 'string' ? args.folderUid : undefined;
    const userId = typeof args.userId === 'number' ? args.userId : undefined;

    let lastText = '';
    let lastSummary: string | undefined;

    for (let i = 0; i < totalChunks; i++) {
        const chunkOps: PatchOperation[] = chunks[i].map((value) => ({
            op: 'add',
            path: '$.panels/-',
            value,
        }));
        if (i === 0 && otherOps.length > 0) {
            chunkOps.unshift(...otherOps);
        }

        const result = await callMcpTool(mcpClient, 'update_dashboard', {
            uid,
            operations: chunkOps,
            message: `${prefix} (${i + 1}/${totalChunks})`,
            folderUid,
            userId,
        });
        const evaluated = evaluateMcpToolResult('update_dashboard', result);
        lastText = evaluated.text;

        const saveStep = pendingTool('update_dashboard');
        const finished = finishTool(saveStep, evaluated);
        if (toolExecutions) {
            toolExecutions.push(finished);
        }
        hooks?.onChunkToolStep?.(finished, i, totalChunks);

        if (!evaluated.ok) {
            return {
                ok: false,
                error: evaluated.error,
                text: lastText,
                summary: evaluated.summary,
                chunksSaved: i,
                totalChunks,
                uid,
            };
        }
        lastSummary = evaluated.summary;
    }

    const panelCount = panelAppends.length;
    const combinedSummary =
        lastSummary ??
        `Saved ${panelCount} panel(s) on uid=${uid} in ${totalChunks} batch(es)`;

    return {
        ok: true,
        text: lastText,
        summary: combinedSummary,
        chunksSaved: totalChunks,
        totalChunks,
        uid,
    };
}

/**
 * Save a full dashboard JSON in panel batches (batch 1 = full JSON + first panels, rest = patch append).
 */
export async function saveDashboardInPanelChunks(
    mcpClient: McpClient,
    dashboard: Record<string, unknown>,
    opts: PanelChunkSaveOptions,
    toolExecutions?: ToolExecution[],
    hooks?: ChunkedUpdateHooks
): Promise<ChunkedUpdateResult> {
    const panels = Array.isArray(dashboard.panels) ? dashboard.panels : [];
    const chunks = splitPanelsIntoChunks(panels, DEFAULT_PANEL_CHUNK_SIZE);
    const totalChunks = chunks.length;
    const startIndex = opts.startChunkIndex ?? 0;
    let targetUid = opts.resumeTargetUid ?? opts.targetUid;
    const prefix = opts.messagePrefix ?? 'Graft dashboard save';
    const folderUid = opts.folderUid;

    if (startIndex >= totalChunks && targetUid) {
        return {
            ok: true,
            text: '',
            summary: `Dashboard uid=${targetUid} already fully saved (${totalChunks} batches)`,
            chunksSaved: totalChunks,
            totalChunks,
            uid: targetUid,
        };
    }

    let lastText = '';
    let lastSummary: string | undefined;

    for (let i = startIndex; i < totalChunks; i++) {
        const chunkPanels = chunks[i];

        if (i === 0) {
            const batchDashboard = { ...dashboard, panels: chunkPanels };
            const first = await saveDashboardFullJson(
                mcpClient,
                batchDashboard,
                {
                    folderUid,
                    overwrite: opts.overwrite ?? Boolean(targetUid),
                    message: `${prefix} batch 1/${totalChunks} (${chunkPanels.length} panel slots)`,
                },
                toolExecutions,
                hooks,
                i,
                totalChunks
            );
            if (!first.ok) {
                return {
                    ok: false,
                    error: first.error,
                    text: first.text,
                    chunksSaved: i,
                    totalChunks,
                    uid: targetUid,
                };
            }
            targetUid = first.uid ?? targetUid;
            lastText = first.text;
            lastSummary = first.summary;
            if (!targetUid) {
                return {
                    ok: false,
                    error: 'First batch saved but no dashboard uid was returned',
                    text: first.text,
                    chunksSaved: i,
                    totalChunks,
                };
            }
        } else {
            if (!targetUid) {
                return {
                    ok: false,
                    error: 'Missing dashboard uid for panel append batch',
                    text: '',
                    chunksSaved: i,
                    totalChunks,
                };
            }
            const appended = await appendPanelChunk(
                mcpClient,
                targetUid,
                chunkPanels,
                {
                    message: `${prefix} batch ${i + 1}/${totalChunks} (${chunkPanels.length} panel slots)`,
                    folderUid,
                },
                toolExecutions,
                hooks,
                i,
                totalChunks
            );
            if (!appended.ok) {
                return {
                    ok: false,
                    error: appended.error,
                    text: appended.text,
                    chunksSaved: i,
                    totalChunks,
                    uid: targetUid,
                };
            }
            lastText = appended.text;
            lastSummary = appended.summary;
        }

        opts.onChunkSaved?.({ chunkIndex: i, totalChunks, uid: targetUid });
    }

    const slotCount = panels.length;
    return {
        ok: true,
        text: lastText,
        summary:
            lastSummary ??
            `Saved dashboard uid=${targetUid} in ${totalChunks} batch(es) (${slotCount} top-level panel slots)`,
        chunksSaved: totalChunks,
        totalChunks,
        uid: targetUid,
    };
}

/**
 * Intercept a large update_dashboard MCP call and run panel batches instead.
 */
export async function executeChunkedUpdateDashboard(
    mcpClient: McpClient,
    args: Record<string, unknown>,
    toolExecutions?: ToolExecution[],
    hooks?: ChunkedUpdateHooks
): Promise<ChunkedUpdateResult> {
    args = applyPanelFixScopeEnforcement(args);

    const dashboard = args.dashboard;
    if (dashboard && typeof dashboard === 'object' && !Array.isArray(dashboard)) {
        const db = dashboard as Record<string, unknown>;
        if (shouldChunkFullDashboard(db)) {
            const existingUid =
                typeof db.uid === 'string'
                    ? db.uid
                    : typeof args.uid === 'string'
                      ? args.uid
                      : undefined;
            return saveDashboardInPanelChunks(
                mcpClient,
                db,
                {
                    folderUid: typeof args.folderUid === 'string' ? args.folderUid : undefined,
                    targetUid: existingUid,
                    overwrite: Boolean(args.overwrite ?? existingUid),
                    messagePrefix:
                        typeof args.message === 'string' ? args.message : 'Graft dashboard save',
                },
                toolExecutions,
                hooks
            );
        }
    }

    if (Array.isArray(args.operations) && typeof args.uid === 'string') {
        return executePatchPanelChunks(mcpClient, args, toolExecutions, hooks);
    }

    return {
        ok: false,
        error: 'executeChunkedUpdateDashboard called with non-chunkable args',
        text: '',
        chunksSaved: 0,
        totalChunks: 0,
    };
}

/** Format combined tool result text returned to the LLM after chunked saves. */
export function formatChunkedUpdateForLlm(result: ChunkedUpdateResult): string {
    const header =
        `[Graft] update_dashboard was split into ${result.totalChunks} panel batch(es) ` +
        `(${result.chunksSaved} succeeded).\n\n`;
    const body = result.ok
        ? formatToolResultForLlm('update_dashboard', result.text)
        : `Error: ${result.error ?? 'chunked save failed'}\n\n${formatToolResultForLlm('update_dashboard', result.text)}`;
    return header + body;
}
