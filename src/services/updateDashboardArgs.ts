import type { PatchOperation } from './dashboardChunkedUpdate';
import {
    enforceScopedPanelDashboardMerge,
    type ScopedPanelFixTarget,
} from './panelFixScope';

/**
 * Coerce a loosely-typed boolean (LLMs frequently emit the string "true"/"false")
 * into a real boolean. Returns undefined when the value is not boolean-like.
 */
export function coerceBooleanLike(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number') {
        return value !== 0;
    }
    if (typeof value === 'string') {
        const v = value.trim().toLowerCase();
        if (v === 'true' || v === '1' || v === 'yes' || v === 'y') {
            return true;
        }
        if (v === 'false' || v === '0' || v === 'no' || v === 'n') {
            return false;
        }
    }
    return undefined;
}

/** Parse JSON embedded in a string field (common LLM mistake). */
export function parseJsonField(value: unknown): unknown {
    if (typeof value !== 'string') {
        return value;
    }
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        return value;
    }
    try {
        return JSON.parse(trimmed);
    } catch {
        return value;
    }
}

/**
 * Grafana MCP expects operations as PatchOperation[], not a JSON string.
 */
export function normalizeUpdateDashboardArgs(args: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...args };

    const dashboard = parseJsonField(out.dashboard);
    if (dashboard !== out.dashboard) {
        out.dashboard = dashboard;
    }

    let operations = parseJsonField(out.operations);
    if (typeof operations === 'string') {
        operations = parseJsonField(operations);
    }
    if (operations !== out.operations) {
        out.operations = operations;
    }

    if (typeof out.operations === 'string') {
        delete out.operations;
    } else if (out.operations != null && !Array.isArray(out.operations)) {
        delete out.operations;
    }

    if (out.dashboard != null && typeof out.dashboard !== 'object') {
        delete out.dashboard;
    }

    // Grafana MCP's UpdateDashboardParams.overwrite is a Go bool — a stringified
    // "true"/"false" (a common LLM mistake) fails with an unmarshal error and
    // aborts the save mid-clone. Coerce it to a real boolean; default to true
    // (our saves overwrite the existing dashboard) when present but unparseable.
    if (out.overwrite !== undefined) {
        out.overwrite = coerceBooleanLike(out.overwrite) ?? true;
    }

    return out;
}

function parseJsonPathSegments(jsonPath: string): (string | number)[] {
    if (!jsonPath.trim().startsWith('$.')) {
        return [];
    }
    const tail = jsonPath.trim().slice(2);
    const segments: (string | number)[] = [];
    for (const part of tail.split('.')) {
        const m = part.match(/^([^\[]+)(.*)$/);
        if (!m?.[1]) {
            continue;
        }
        segments.push(m[1]);
        const idxRe = /\[(\d+)\]/g;
        let im: RegExpExecArray | null;
        while ((im = idxRe.exec(m[2] ?? ''))) {
            segments.push(Number(im[1]));
        }
    }
    return segments;
}

function getAtSegment(current: unknown, key: string | number): unknown {
    if (current == null || typeof current !== 'object') {
        return undefined;
    }
    if (typeof key === 'number' && Array.isArray(current)) {
        return current[key];
    }
    return (current as Record<string, unknown>)[String(key)];
}

function setValueAtJsonPath(root: Record<string, unknown>, jsonPath: string, value: unknown): boolean {
    const segments = parseJsonPathSegments(jsonPath);
    if (segments.length === 0) {
        return false;
    }

    let current: unknown = root;
    for (let i = 0; i < segments.length - 1; i++) {
        current = getAtSegment(current, segments[i]);
        if (current === undefined) {
            return false;
        }
    }

    const last = segments[segments.length - 1];
    if (current == null || typeof current !== 'object') {
        return false;
    }
    if (typeof last === 'number' && Array.isArray(current)) {
        current[last] = value;
        return true;
    }
    (current as Record<string, unknown>)[String(last)] = value;
    return true;
}

function applyReplaceOperationsToDashboard(
    baseline: Record<string, unknown>,
    operations: PatchOperation[]
): Record<string, unknown> {
    const copy = JSON.parse(JSON.stringify(baseline)) as Record<string, unknown>;
    for (const op of operations) {
        if (!op || typeof op !== 'object') {
            continue;
        }
        const path = (op as PatchOperation).path;
        if (op.op === 'replace' && typeof path === 'string') {
            setValueAtJsonPath(copy, path, (op as PatchOperation).value);
        }
    }
    return copy;
}

/**
 * Scoped panel fix: prefer full dashboard JSON (reliable MCP). Coerce patch-only calls.
 */
export function coerceScopedPanelFixUpdateArgs(
    args: Record<string, unknown>,
    baseline: Record<string, unknown>,
    scope: ScopedPanelFixTarget
): Record<string, unknown> {
    const normalized = normalizeUpdateDashboardArgs(args);

    if (normalized.dashboard && typeof normalized.dashboard === 'object' && !Array.isArray(normalized.dashboard)) {
        return normalized;
    }

    if (Array.isArray(normalized.operations) && normalized.operations.length > 0) {
        const patched = applyReplaceOperationsToDashboard(baseline, normalized.operations as PatchOperation[]);
        const { merged } = enforceScopedPanelDashboardMerge(baseline, patched, scope);
        const uid =
            typeof normalized.uid === 'string'
                ? normalized.uid
                : typeof baseline.uid === 'string'
                  ? baseline.uid
                  : scope.dashboardUid;
        const { operations: _removed, ...rest } = normalized;
        return {
            ...rest,
            uid,
            dashboard: merged,
            overwrite: normalized.overwrite ?? true,
        };
    }

    return normalized;
}
