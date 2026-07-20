/**
 * Machine ids Graft remaps in clones:
 * - PowerTech: 2103-176030 / 2505-200033 (4 digits, hyphen, 6+ digits — not ISO dates like 2026-05)
 * - ElectraMet SIM-style: ElectraMetBRC-SIM-177121
 */
export const MACHINE_ID_PATTERN =
    /(?:[0-9]{4}-[0-9]{6,}|[A-Za-z][A-Za-z0-9]*-SIM-[0-9]{3,}|ElectraMet[A-Za-z0-9]*-[A-Za-z0-9]+-[0-9]{3,})/;

export function isMachineId(value: string | undefined): boolean {
    if (!value) {
        return false;
    }
    // Reject short ISO-like YYYY-MM tokens that appear in panel JSON / time ranges.
    if (/^[0-9]{4}-[0-9]{1,2}$/.test(value)) {
        return false;
    }
    return new RegExp(`^${MACHINE_ID_PATTERN.source}$`).test(value);
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
    const idGroup = MACHINE_ID_PATTERN.source;
    const visual = cloneIntentMessage.match(new RegExp(`\\bvisual copy of\\s+(${idGroup})`, 'i'));
    if (visual?.[1] && isMachineId(visual[1])) {
        return visual[1];
    }
    const copyOf = cloneIntentMessage.match(new RegExp(`\\bcopy of\\s+(${idGroup})`, 'i'));
    if (copyOf?.[1] && isMachineId(copyOf[1])) {
        return copyOf[1];
    }
    const ids = findMachineIdsInText(cloneIntentMessage);
    if (ids.length >= 2) {
        // Prefer a PowerTech ####-###### as the template when one ElectraMet target is also present.
        const powerTech = ids.find((id) => /^[0-9]{4}-[0-9]{6,}$/.test(id));
        const targetHint = extractTargetMachineIdPreferringPhrases(cloneIntentMessage);
        if (powerTech && targetHint && powerTech !== targetHint) {
            return powerTech;
        }
        return ids[0];
    }
    return ids[0];
}

/** Prefer explicit "data for X" / "for X" phrases before falling back to id list. */
function extractTargetMachineIdPreferringPhrases(cloneIntentMessage: string): string | undefined {
    const idGroup = MACHINE_ID_PATTERN.source;
    const dataFor = cloneIntentMessage.match(
        new RegExp(`\\b(?:with\\s+)?data\\s+for\\s+(${idGroup})`, 'i')
    );
    if (dataFor?.[1] && isMachineId(dataFor[1])) {
        return dataFor[1];
    }

    const forMatches = [
        ...cloneIntentMessage.matchAll(new RegExp(`\\bfor\\s+(${idGroup})`, 'gi')),
    ];
    if (forMatches.length > 0) {
        const last = forMatches[forMatches.length - 1][1];
        if (last && isMachineId(last)) {
            return last;
        }
    }
    return undefined;
}

/** Target machine for data (e.g. 2505-200033 from "data for 2505-200033"). */
export function extractTargetMachineId(cloneIntentMessage: string): string | undefined {
    const fromPhrase = extractTargetMachineIdPreferringPhrases(cloneIntentMessage);
    if (fromPhrase) {
        return fromPhrase;
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
            error:
                'Could not find template machine id (e.g. "copy of 2103-176030" or "copy of ElectraMetBRC-SIM-177121").',
            sourceMachineId,
            targetMachineId,
        };
    }
    if (!targetMachineId || !isMachineId(targetMachineId)) {
        return {
            valid: false,
            error:
                'Could not find target machine id (e.g. "data for 2505-200033" or "data for ElectraMetBRC-SIM-177121"). Avoid phrasing like "machine from Vendor" without the id.',
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
