import { extractDashboardUidFromMessage } from './dashboardMentionParse';
import { extractRequestedDashboardTitle, findMachineIdsInText } from './dashboardCloneParse';
import {
    latestNonContinueUserMessage,
    userWantsDashboardClone,
    userWantsDashboardPanelFix,
} from './dashboardCloneProgress';
import { userWantsDashboardWork } from './llm';
import { assistantAwaitingModuleReorderConfirm, userWantsModulePanelReorder } from './modulePanelReorderParse';
import type { ToolExecution } from '../types/llm.types';

export type PendingDashboardTaskKind =
    | 'clone'
    | 'panel_fix'
    | 'module_reorder'
    | 'layout'
    | 'dashboard_edit';

export interface PendingDashboardTask {
    kind: PendingDashboardTaskKind;
    intentMessage: string;
    dashboardUid?: string;
    dashboardTitle?: string;
    assistantPrompt?: string;
    options?: Record<string, unknown>;
    updatedAt: number;
}

const STORAGE_KEY = 'graft_pending_dashboard_task';

function readJson<T>(key: string): T | null {
    try {
        const raw = sessionStorage.getItem(key);
        return raw ? (JSON.parse(raw) as T) : null;
    } catch {
        return null;
    }
}

function writeJson(key: string, value: unknown): void {
    try {
        sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
        // ignore
    }
}

export function getPendingDashboardTask(): PendingDashboardTask | null {
    return readJson<PendingDashboardTask>(STORAGE_KEY);
}

export function setPendingDashboardTask(task: PendingDashboardTask): void {
    writeJson(STORAGE_KEY, task);
}

export function clearPendingDashboardTask(): void {
    try {
        sessionStorage.removeItem(STORAGE_KEY);
    } catch {
        // ignore
    }
}

export function inferPendingTaskKind(message: string): PendingDashboardTaskKind {
    if (userWantsDashboardClone(message)) {
        return 'clone';
    }
    if (userWantsModulePanelReorder(message)) {
        return 'module_reorder';
    }
    if (userWantsDashboardPanelFix(message)) {
        return 'panel_fix';
    }
    if (/\b(re-?\s*arrang|reorder|gridPos|layout|same\s+size)\b/i.test(message)) {
        return 'layout';
    }
    return 'dashboard_edit';
}

export function inferDashboardIdentity(message: string): {
    dashboardUid?: string;
    dashboardTitle?: string;
} {
    const machines = findMachineIdsInText(message);
    const uid = extractDashboardUidFromMessage(message);
    let dashboardTitle = extractRequestedDashboardTitle(message, machines[0]);
    if (!dashboardTitle && machines[0]) {
        const slash = message.match(
            new RegExp(`\\b${machines[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\/\\s*[^.,\\n"]+`, 'i')
        );
        if (slash?.[0]) {
            dashboardTitle = slash[0].trim();
        }
    }
    if (!dashboardTitle) {
        const onDash = message.match(/\bon\s+dashboard\s+([0-9]{4}-[0-9]+\s*\/\s*\S+)/i);
        if (onDash?.[1]) {
            dashboardTitle = onDash[1].trim();
        }
    }
    return { dashboardUid: uid, dashboardTitle };
}

/** Short user replies that should resume the open dashboard task. */
export function isShortFollowUpMessage(message: string): boolean {
    const text = message.trim();
    if (!text || text.length > 280) {
        return false;
    }
    if (/^continue\.?$/i.test(text)) {
        return true;
    }
    if (userWantsDashboardWork(text) && text.length > 80) {
        return false;
    }
    return (
        /^(yes|yep|yeah|sure|ok|okay|go ahead|do it|please|confirmed|proceed)\b/i.test(text) ||
        (/\byes\b/i.test(text) && /\b(order|including|all|every|randomforest|influx|end|as well|ones at end)\b/i.test(text)) ||
        (/\bin order\b/i.test(text) && /\b(including|module|randomforest|end)\b/i.test(text)) ||
        (/\b(include|including)\b/i.test(text) && /\b(randomforest|influx|end|all)\b/i.test(text))
    );
}

/** Assistant ended with a question / confirmation gate instead of saving. */
export function assistantAskedPendingQuestion(assistantContent: string): boolean {
    const text = assistantContent.trim();
    if (!text) {
        return false;
    }
    if (assistantAwaitingModuleReorderConfirm(text)) {
        return true;
    }
    return (
        /\b(Would you like|Which would you prefer|Should I also|Do you want me to|Please choose|Let me know which|Reply with \*\*Continue\*\*)\b/i.test(
            text
        ) ||
        /\b(Could you please provide|I need more context|need more context|clarify what items)\b/i.test(text) ||
        /\b(Should I also move|keep them at the end)\b/i.test(text)
    );
}

export function buildConfirmedIntent(task: PendingDashboardTask, userReply: string): string {
    const dash =
        task.dashboardTitle != null
            ? `Dashboard: "${task.dashboardTitle}"${task.dashboardUid ? ` (uid ${task.dashboardUid})` : ''}.`
            : task.dashboardUid
              ? `Dashboard uid: ${task.dashboardUid}.`
              : '';
    const assistant bit = task.assistantPrompt
        ? `You previously asked: ${task.assistantPrompt.slice(0, 400)}`
        : '';
    return (
        `${task.intentMessage}\n\n` +
        `[Operator confirmation — execute now, do not ask again]\n` +
        `User replied: "${userReply.trim()}". Treat this as approval to complete the full request (including any optional parts you asked about).\n` +
        `${dash}\n${assistantBit}\n` +
        `Call get_dashboard_by_uid then update_dashboard in this turn. Do not respond with generic "need more context" — finish the dashboard change.`
    );
}

export interface ResolveEffectiveUserMessageResult {
    effective: string;
    replaced: boolean;
    pending?: PendingDashboardTask | null;
}

/**
 * Rewrites short follow-ups into the original dashboard intent so the LLM/programmatic path can finish the job.
 */
export function resolveEffectiveUserMessage(
    currentMessage: string,
    context: {
        priorUserMessages: string[];
        lastAssistantMessage?: string;
    }
): ResolveEffectiveUserMessageResult {
    const current = currentMessage.trim();
    if (!current) {
        return { effective: current, replaced: false };
    }

    const pending = getPendingDashboardTask();
    const priorUser = latestNonContinueUserMessage(context.priorUserMessages);
    const lastAssistant = context.lastAssistantMessage?.trim() ?? '';

    if (isShortFollowUpMessage(current)) {
        if (pending?.intentMessage) {
            return {
                effective: buildConfirmedIntent(pending, current),
                replaced: true,
                pending,
            };
        }
        if (priorUser && lastAssistant && assistantAskedPendingQuestion(lastAssistant)) {
            const identity = inferDashboardIdentity(priorUser);
            const recovered: PendingDashboardTask = {
                kind: inferPendingTaskKind(priorUser),
                intentMessage: priorUser,
                ...identity,
                assistantPrompt: lastAssistant.slice(0, 500),
                updatedAt: Date.now(),
            };
            setPendingDashboardTask(recovered);
            return {
                effective: buildConfirmedIntent(recovered, current),
                replaced: true,
                pending: recovered,
            };
        }
    }

    if (userWantsDashboardWork(current) && !isShortFollowUpMessage(current)) {
        const identity = inferDashboardIdentity(current);
        setPendingDashboardTask({
            kind: inferPendingTaskKind(current),
            intentMessage: current,
            ...identity,
            updatedAt: Date.now(),
        });
    }

    return { effective: current, replaced: false, pending };
}

export function recordPendingTaskAfterAssistantTurn(
    userMessage: string,
    assistantContent: string,
    toolExecutions: ToolExecution[]
): void {
    const saved = toolExecutions.some((t) => t.name === 'update_dashboard' && t.status === 'success');
    if (saved) {
        clearPendingDashboardTask();
        return;
    }

    const intent = userMessage.trim() || getPendingDashboardTask()?.intentMessage;
    if (!intent || !assistantAskedPendingQuestion(assistantContent)) {
        return;
    }

    const existing = getPendingDashboardTask();
    const identity = inferDashboardIdentity(intent);
    setPendingDashboardTask({
        kind: existing?.kind ?? inferPendingTaskKind(intent),
        intentMessage: intent,
        dashboardUid: existing?.dashboardUid ?? identity.dashboardUid,
        dashboardTitle: existing?.dashboardTitle ?? identity.dashboardTitle,
        assistantPrompt: assistantContent.slice(0, 600),
        options: existing?.options,
        updatedAt: Date.now(),
    });
}

/** Strong continuation prompt when a pending dashboard task exists in session. */
export function buildContinuationFromPendingTask(userReply = 'Continue'): string | null {
    const pending = getPendingDashboardTask();
    if (!pending?.intentMessage) {
        return null;
    }
    return buildConfirmedIntent(pending, userReply);
}

export function formatPendingTaskContextBlock(): string {
    const pending = getPendingDashboardTask();
    if (!pending) {
        return '';
    }
    const lines = [
        '',
        '## Open dashboard task (browser session)',
        `Kind: ${pending.kind}`,
        `Original request: ${pending.intentMessage}`,
    ];
    if (pending.dashboardTitle) {
        lines.push(`Dashboard title: ${pending.dashboardTitle}`);
    }
    if (pending.dashboardUid) {
        lines.push(`Dashboard uid: ${pending.dashboardUid}`);
    }
    if (pending.assistantPrompt) {
        lines.push(`Last assistant question: ${pending.assistantPrompt.slice(0, 300)}`);
    }
    lines.push(
        'If the user sends a short confirmation (yes / in order / including all / Continue), execute this task immediately — do not ask what to order.'
    );
    return lines.join('\n');
}
