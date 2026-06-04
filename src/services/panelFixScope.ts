import type { PatchOperation } from './dashboardChunkedUpdate';
import {
    extractDashboardUidFromMessage,
    extractPanelArrayIndexFromMessage,
    extractPanelIdFromMessage,
    extractPanelTitleFromMessage,
} from './dashboardMentionParse';
import { userWantsBulkPeerBandFix } from './bulkPeerBandFixParse';
import { isCrossDashboardPeerBandCopyIntent } from './peerBandShared';

export interface ScopedPanelFixTarget {
    dashboardUid: string;
    panelId?: number;
    panelTitle?: string;
    /** Top-level dashboard.panels array index (Grafana arrayIndex). */
    panelArrayIndex?: number;
}

export function parseScopedPanelFixRequest(message: string): ScopedPanelFixTarget | null {
    const text = message.trim();
    if (!text) {
        return null;
    }

    if (userWantsBulkPeerBandFix(text)) {
        return null;
    }

    if (isCrossDashboardPeerBandCopyIntent(text)) {
        return null;
    }

    const dashboardUid = extractDashboardUidFromMessage(text);
    const panelId = extractPanelIdFromMessage(text);
    const panelArrayIndex = extractPanelArrayIndexFromMessage(text);
    const panelTitle = extractPanelTitleFromMessage(text);

    if (!dashboardUid) {
        return null;
    }

    const hasPanelContext =
        panelId != null || panelArrayIndex != null || Boolean(panelTitle) || /\bpanel\b/i.test(text);
    const hasErrorContext =
        /\b(error|errors|Status:\s*\d+|parse error|bad_data|unexpected argument|undefined identifier)\b/i.test(
            text
        ) ||
        /\b(fix|ix|repair|correct)\b/i.test(text) ||
        /\bdo not change other panels?\b/i.test(text);

    if (!hasPanelContext) {
        return null;
    }

    if (panelId == null && panelArrayIndex == null && !panelTitle && !hasErrorContext) {
        return null;
    }

    return {
        dashboardUid,
        panelId,
        panelTitle: panelTitle || undefined,
        panelArrayIndex,
    };
}

export function isScopedPanelFixRequest(message: string): boolean {
    return parseScopedPanelFixRequest(message) != null;
}

/** Scoped "fix only this panel" phrasing (incl. common "ix only" typo). */
export function isExplicitScopedPanelFixCommand(message: string): boolean {
    if (userWantsBulkPeerBandFix(message)) {
        return false;
    }
    if (!parseScopedPanelFixRequest(message)) {
        return false;
    }
    if (/\bfix\s+all\b/i.test(message)) {
        return false;
    }
    if (/\b(all|every|each)\b/i.test(message) && /\bpanel/i.test(message)) {
        return false;
    }
    return (
        /\b(fix|ix|repair|correct)\s+only\b/i.test(message) ||
        /\bonly\s+panel\b/i.test(message) ||
        /\bdo not change other panels?\b/i.test(message)
    );
}

export function buildScopedPanelFixLlmMessage(scope: ScopedPanelFixTarget, userMessage: string): string {
    const panelRef =
        scope.panelId != null
            ? `panelId **${scope.panelId}** (Grafana JSON \`id\` field — verify with get_dashboard_summary)`
            : `panel titled **${scope.panelTitle}**`;
    const fluxHint =
        /\b(flux|stddev|unexpected argument|undefined identifier)\b/i.test(userMessage)
            ? `\nFlux hint: errors like "unexpected argument by" or undefined stdDev/mean_val mean the panel query is invalid Flux (not PromQL). ` +
              `Rewrite only that panel's Influx/Flux target strings using valid Flux syntax, or switch datasource/query type if the panel should be PromQL.\n`
            : '';
    const promqlHint =
        /\bparse error\b/i.test(userMessage) && !fluxHint
            ? `\nPromQL hint: "unexpected identifier \`v\`" often means a broken variable/ref (stray \`v\`, unclosed paren, or a corrupted template). Fix syntax in **this panel's** query expr only.\n`
            : '';

    return (
        `Scoped panel fix — change ONLY ONE panel, then save.\n\n` +
        `User request: ${userMessage}\n\n` +
        `**Scope (mandatory):**\n` +
        `- Dashboard uid: \`${scope.dashboardUid}\`\n` +
        `- Target: ${panelRef}\n` +
        `- **panel id** is the Grafana JSON \`id\` field — it is **NOT** the arrayIndex column from panel tables.\n` +
        `- If id and title disagree, fix the panel **by title**.\n` +
        `- Do **NOT** modify, retitle, or re-query any other panel.\n` +
        fluxHint +
        promqlHint +
        `\nSteps (all required this turn):\n` +
        `1. \`get_dashboard_by_uid\` uid=${scope.dashboardUid}\n` +
        `2. Locate panel id ${scope.panelId ?? '(from summary)'}; fix ONLY its query targets (expr / Flux script).\n` +
        `3. \`update_dashboard\` with the **full dashboard JSON** in the \`dashboard\` field (include current \`version\`). ` +
        `Do **NOT** use \`operations\` / JSON-patch mode — it often fails MCP parsing.\n` +
        `4. Confirm save returned uid and version before any summary text.\n` +
        `Forbidden: ending after lookup only; stringified operations; asking the user for uid/panel id again.\n`
    );
}

/** LLM-only continuation for scoped panel fix (user may type Continue in chat). */
export function buildForcedPanelFixContinueLlmMessage(
    scope: ScopedPanelFixTarget,
    toolExecutions: { name: string; status: string; error?: string; summary?: string }[] = []
): string {
    const panelRef =
        scope.panelId != null ? `panelId ${scope.panelId}` : `panel "${scope.panelTitle ?? 'target'}"`;
    const lastUpdate = [...toolExecutions].reverse().find((t) => t.name === 'update_dashboard');
    const lastGet = [...toolExecutions].reverse().find((t) => t.name === 'get_dashboard_by_uid');
    const errLine =
        lastUpdate?.status === 'error' && lastUpdate.error
            ? `\nLast save error: ${lastUpdate.error.slice(0, 400)}\n`
            : lastGet?.status === 'error' && lastGet.error
              ? `\nLast load error: ${lastGet.error.slice(0, 400)}\n`
              : '';

    return (
        `Continue — MANDATORY save for scoped panel fix.\n\n` +
        `Dashboard uid=${scope.dashboardUid}, ${panelRef} only. Do not edit other panels.\n` +
        errLine +
        `\nCall get_dashboard_by_uid uid=${scope.dashboardUid}, fix queries on ${panelRef}, then update_dashboard. ` +
        `Do not reply with status text until update_dashboard succeeds.`
    );
}

type PanelRecord = Record<string, unknown>;

function normalizeTitle(title: unknown): string {
    return typeof title === 'string' ? title.trim().toLowerCase() : '';
}

export function panelMatchesTarget(panel: PanelRecord, target: ScopedPanelFixTarget): boolean {
    if (target.panelId != null && panel.id === target.panelId) {
        return true;
    }
    if (target.panelTitle) {
        const t = normalizeTitle(panel.title);
        const want = normalizeTitle(target.panelTitle);
        if (t && want && (t === want || t.includes(want) || want.includes(t))) {
            return true;
        }
    }
    return false;
}

export function replacePanelAtPath(
    dashboard: Record<string, unknown>,
    path: number[],
    replacement: PanelRecord
): boolean {
    const panels = dashboard.panels;
    if (!Array.isArray(panels) || path.length === 0) {
        return false;
    }
    return setPanelAtPath(panels, path, replacement);
}

export function replacePanelInDashboard(
    dashboard: Record<string, unknown>,
    target: ScopedPanelFixTarget,
    replacement: PanelRecord
): boolean {
    const panels = dashboard.panels;
    if (!Array.isArray(panels)) {
        return false;
    }
    const path = findPanelPath(panels, target);
    if (!path) {
        return false;
    }
    return setPanelAtPath(panels, path, replacement);
}

export function findPanelInTree(
    panels: unknown,
    target: ScopedPanelFixTarget
): PanelRecord | null {
    if (!Array.isArray(panels)) {
        return null;
    }
    for (const item of panels) {
        if (!item || typeof item !== 'object') {
            continue;
        }
        const panel = item as PanelRecord;
        if (panelMatchesTarget(panel, target)) {
            return panel;
        }
        const nested = findPanelInTree(panel.panels, target);
        if (nested) {
            return nested;
        }
    }
    return null;
}

type PanelPath = number[];

function findPanelPath(panels: unknown, target: ScopedPanelFixTarget, path: PanelPath = []): PanelPath | null {
    if (!Array.isArray(panels)) {
        return null;
    }
    for (let i = 0; i < panels.length; i++) {
        const panel = panels[i] as PanelRecord;
        const nextPath = [...path, i];
        if (panelMatchesTarget(panel, target)) {
            return nextPath;
        }
        const nested = findPanelPath(panel.panels, target, nextPath);
        if (nested) {
            return nested;
        }
    }
    return null;
}

function panelJsonPathPrefix(path: PanelPath): string {
    let prefix = '$.panels';
    for (let i = 0; i < path.length; i++) {
        prefix += `[${path[i]}]`;
        if (i < path.length - 1) {
            prefix += '.panels';
        }
    }
    return prefix;
}

function setPanelAtPath(rootPanels: unknown[], path: PanelPath, replacement: PanelRecord): boolean {
    if (path.length === 0) {
        return false;
    }
    let current: unknown[] = rootPanels;
    for (let i = 0; i < path.length - 1; i++) {
        const node = current[path[i]] as PanelRecord;
        if (!node?.panels || !Array.isArray(node.panels)) {
            return false;
        }
        current = node.panels;
    }
    current[path[path.length - 1]] = replacement;
    return true;
}

function countPanelsInTree(panels: unknown): number {
    if (!Array.isArray(panels)) {
        return 0;
    }
    let n = 0;
    for (const item of panels) {
        if (!item || typeof item !== 'object') {
            continue;
        }
        const panel = item as PanelRecord;
        if (typeof panel.id === 'number' || typeof panel.title === 'string') {
            n += 1;
        }
        n += countPanelsInTree(panel.panels);
    }
    return n;
}

export function enforceScopedPanelDashboardMerge(
    baseline: Record<string, unknown>,
    proposed: Record<string, unknown>,
    target: ScopedPanelFixTarget
): { merged: Record<string, unknown>; panelsReverted: number } {
    const merged = JSON.parse(JSON.stringify(baseline)) as Record<string, unknown>;
    const basePanels = merged.panels;
    const propPanels = proposed.panels;
    if (!Array.isArray(basePanels) || !Array.isArray(propPanels)) {
        return { merged: baseline, panelsReverted: 0 };
    }

    const path = findPanelPath(basePanels, target);
    const replacement = findPanelInTree(propPanels, target);
    if (!path || !replacement) {
        return { merged: baseline, panelsReverted: countPanelsInTree(propPanels) };
    }

    setPanelAtPath(basePanels, path, JSON.parse(JSON.stringify(replacement)) as PanelRecord);

    const version =
        typeof proposed.version === 'number'
            ? proposed.version
            : typeof baseline.version === 'number'
              ? baseline.version
              : undefined;
    if (version != null) {
        merged.version = version;
    }
    if (typeof proposed.uid === 'string') {
        merged.uid = proposed.uid;
    }

    const total = countPanelsInTree(propPanels);
    return { merged, panelsReverted: Math.max(0, total - 1) };
}

export function findPanelJsonPathPrefix(
    baseline: Record<string, unknown>,
    target: ScopedPanelFixTarget
): string | undefined {
    const panels = baseline.panels;
    if (!Array.isArray(panels)) {
        return undefined;
    }
    const path = findPanelPath(panels, target);
    return path ? panelJsonPathPrefix(path) : undefined;
}

export function enforceScopedPanelUpdateArgs(
    args: Record<string, unknown>,
    target: ScopedPanelFixTarget,
    baseline: Record<string, unknown> | null
): { args: Record<string, unknown>; panelsReverted: number } {
    if (!baseline) {
        return { args, panelsReverted: 0 };
    }

    if (args.dashboard && typeof args.dashboard === 'object' && !Array.isArray(args.dashboard)) {
        const proposed = args.dashboard as Record<string, unknown>;
        const { merged, panelsReverted } = enforceScopedPanelDashboardMerge(
            baseline,
            proposed,
            target
        );
        return {
            args: { ...args, dashboard: merged },
            panelsReverted,
        };
    }

    if (Array.isArray(args.operations) && typeof args.uid === 'string') {
        const allowedPrefix = findPanelJsonPathPrefix(baseline, target);
        if (!allowedPrefix) {
            return { args: { ...args, operations: [] }, panelsReverted: (args.operations as []).length };
        }
        const ops = args.operations as PatchOperation[];
        const filtered = ops.filter((op) => {
            const p = (op.path ?? '').trim();
            return (
                p === allowedPrefix ||
                p.startsWith(`${allowedPrefix}.`) ||
                p.startsWith(`${allowedPrefix}[`)
            );
        });
        return {
            args: { ...args, operations: filtered },
            panelsReverted: ops.length - filtered.length,
        };
    }

    return { args, panelsReverted: 0 };
}

