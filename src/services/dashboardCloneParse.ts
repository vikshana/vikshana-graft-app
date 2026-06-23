/** PowerTech-style machine id, e.g. 2103-176030 or 2505-200033 (6+ digits after hyphen — not ISO dates like 2026-05). */
export const MACHINE_ID_PATTERN = /[0-9]{4}-[0-9]{6,}/;

export function isMachineId(value: string | undefined): boolean {
    return Boolean(value && /^[0-9]{4}-[0-9]{6,}$/.test(value));
}

/** All machine ids in message order (deduped). Ignores date-like YYYY-MM tokens from panel JSON. */
export function findMachineIdsInText(message: string): string[] {
    const ids: string[] = [];
    for (const m of message.matchAll(new RegExp(MACHINE_ID_PATTERN.source, 'g'))) {
        if (m[0] && isMachineId(m[0])) {
            ids.push(m[0]);
        }
    }
    return [...new Set(ids)];
}

/** Template machine to copy (e.g. 2103-176030 from "copy of 2103-176030"). */
export function extractSourceMachineId(cloneIntentMessage: string): string | undefined {
    const visual = cloneIntentMessage.match(/\bvisual copy of\s+([0-9]{4}-[0-9]+)/i);
    if (visual?.[1]) {
        return visual[1];
    }
    const copyOf = cloneIntentMessage.match(/\bcopy of\s+([0-9]{4}-[0-9]+)/i);
    if (copyOf?.[1]) {
        return copyOf[1];
    }
    const ids = findMachineIdsInText(cloneIntentMessage);
    if (ids.length >= 2) {
        return ids[0];
    }
    return ids[0];
}

/** Target machine for data (e.g. 2505-200033 from "data for 2505-200033"). */
export function extractTargetMachineId(cloneIntentMessage: string): string | undefined {
    const dataFor = cloneIntentMessage.match(/\b(?:with\s+)?data\s+for\s+([0-9]{4}-[0-9]+)/i);
    if (dataFor?.[1]) {
        return dataFor[1];
    }

    const forMatches = [...cloneIntentMessage.matchAll(/\bfor\s+([0-9]{4}-[0-9]+)/gi)];
    if (forMatches.length > 0) {
        return forMatches[forMatches.length - 1][1];
    }

    const source = extractSourceMachineId(cloneIntentMessage);
    const ids = findMachineIdsInText(cloneIntentMessage);
    if (source && ids.length >= 2) {
        const other = ids.find((id) => id !== source);
        if (other) {
            return other;
        }
    }
    if (ids.length === 1) {
        return ids[0];
    }
    return undefined;
}

/** @deprecated Use extractTargetMachineId — kept as alias for callers. */
export function extractMachineFromRequest(userContent: string): string | undefined {
    return extractTargetMachineId(userContent);
}

/**
 * Compose the final title from a user-supplied label. A bare label like "Keysight"
 * for machine 2505-200033 becomes "2505-200033 / Keysight" (the PowerTech convention,
 * matching `from Keysight` and `rename … to be "Keysight"`). A label that already
 * carries a slash or its own machine id is treated as a full title and kept verbatim.
 */
function composeTitleFromLabel(label: string, targetMachine?: string): string {
    const trimmed = label.trim();
    if (!trimmed) {
        return trimmed;
    }
    if (trimmed.includes('/') || findMachineIdsInText(trimmed).length > 0) {
        return trimmed;
    }
    if (targetMachine && isMachineId(targetMachine)) {
        return `${targetMachine} / ${trimmed}`;
    }
    return trimmed;
}

export function extractRequestedDashboardTitle(
    userContent: string,
    targetMachine?: string
): string | undefined {
    // An explicit quoted name is taken literally (the user spelled out the exact title).
    const quoted = userContent.match(/\bnamed\s+"([^"]+)"/i);
    if (quoted?.[1]?.trim()) {
        return quoted[1].trim();
    }
    // Unquoted `named Keysight …` — capture the label up to the next clause keyword
    // ("for"/"that"/"with"/…) or punctuation so we don't swallow "for 2505-200033".
    const bare = userContent.match(
        /\bnamed\s+([^",.\n]+?)(?=\s+(?:for|that|which|with|to|as|copy|of|from|using)\b|[,.]|$)/i
    );
    if (bare?.[1]?.trim()) {
        return composeTitleFromLabel(bare[1], targetMachine);
    }
    if (targetMachine) {
        const withSlash = userContent.match(
            new RegExp(`\\b(${targetMachine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\/\\s*[^.,\\n"]+)`, 'i')
        );
        if (withSlash?.[1]) {
            return withSlash[1].trim();
        }
    }
    return undefined;
}

/**
 * Default new dashboard title when the user does not name one explicitly. Use the bare
 * machine id (e.g. "2505-200033") — a neutral, accurate default. A later rename like
 * `to be "Keysight"` becomes "2505-200033 / Keysight". (Previously this injected a
 * developer placeholder "GlenTest", which leaked into real dashboards.)
 */
export function defaultDashboardTitleForMachine(targetMachine: string): string {
    return targetMachine;
}

/** e.g. "machine from Keysight for 2505-200033" → "2505-200033 / Keysight" */
export function inferDefaultDashboardTitle(message: string, targetMachine: string): string {
    const named = extractRequestedDashboardTitle(message, targetMachine);
    if (named) {
        return named;
    }
    const vendor = message.match(/\bfrom\s+([A-Za-z][A-Za-z0-9_-]*)\b/i);
    if (vendor?.[1] && !isMachineId(vendor[1])) {
        return `${targetMachine} / ${vendor[1]}`;
    }
    return defaultDashboardTitleForMachine(targetMachine);
}

/** Always derive machine/title from the original user message (ignores stale session meta). */
export function getEffectiveCloneFieldsFromIntent(intent: string): {
    requestedTitle?: string;
    requestedMachine?: string;
    sourceMachineId?: string;
    valid: boolean;
} {
    const parsed = parseCloneIntentMessage(intent);
    if (parsed.valid) {
        return {
            requestedTitle:
                parsed.requestedTitle ?? inferDefaultDashboardTitle(intent, parsed.targetMachineId!),
            requestedMachine: parsed.targetMachineId,
            sourceMachineId: parsed.sourceMachineId,
            valid: true,
        };
    }
    const targetMachineId = extractTargetMachineId(intent);
    const sourceMachineId = extractSourceMachineId(intent);
    return {
        requestedTitle: targetMachineId
            ? inferDefaultDashboardTitle(intent, targetMachineId)
            : undefined,
        requestedMachine: isMachineId(targetMachineId) ? targetMachineId : undefined,
        sourceMachineId: isMachineId(sourceMachineId) ? sourceMachineId : undefined,
        valid: false,
    };
}

export interface ParsedCloneIntent {
    sourceMachineId?: string;
    targetMachineId?: string;
    requestedTitle?: string;
    valid: boolean;
    error?: string;
}

export function parseCloneIntentMessage(message: string): ParsedCloneIntent {
    const sourceMachineId = extractSourceMachineId(message);
    const targetMachineId = extractTargetMachineId(message);
    const requestedTitle =
        extractRequestedDashboardTitle(message, targetMachineId) ??
        (targetMachineId ? inferDefaultDashboardTitle(message, targetMachineId) : undefined);

    if (!sourceMachineId || !isMachineId(sourceMachineId)) {
        return {
            valid: false,
            error: 'Could not find template machine id (e.g. "copy of 2103-176030").',
            sourceMachineId,
            targetMachineId,
        };
    }
    if (!targetMachineId || !isMachineId(targetMachineId)) {
        return {
            valid: false,
            error: 'Could not find target machine id (e.g. "data for 2505-200033"). Avoid phrasing like "machine from Vendor" without the id.',
            sourceMachineId,
            targetMachineId,
        };
    }
    if (sourceMachineId === targetMachineId) {
        return {
            valid: false,
            error: 'Template and target machine ids must be different.',
            sourceMachineId,
            targetMachineId,
        };
    }

    return {
        valid: true,
        sourceMachineId,
        targetMachineId,
        requestedTitle,
    };
}
