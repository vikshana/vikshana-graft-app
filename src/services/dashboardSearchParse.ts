import type { ToolExecution } from '../types/llm.types';
import { parseJsonFromMcpText } from './mcpToolClient';

export interface DashboardSearchHit {
    uid: string;
    title: string;
    tags?: string[];
}

function parseSearchHitsFromMarkdownTable(text: string): DashboardSearchHit[] {
    const hits: DashboardSearchHit[] = [];
    for (const row of text.matchAll(/\|\s*\d+\s*\|\s*([^|]+)\s*\|\s*`([^`]+)`\s*\|/g)) {
        const title = row[1]?.trim();
        const uid = row[2]?.trim();
        if (title && uid) {
            hits.push({ title, uid });
        }
    }
    return hits;
}

/** Parse raw search_dashboards MCP JSON (and optional markdown reference tables). */
export function parseSearchHitsFromMcpText(text: string): DashboardSearchHit[] {
    const hits: DashboardSearchHit[] = [];
    const parsed = parseJsonFromMcpText(text);
    if (parsed && typeof parsed === 'object') {
        const dashboards = (parsed as { dashboards?: unknown[] }).dashboards;
        if (Array.isArray(dashboards)) {
            for (const d of dashboards) {
                if (!d || typeof d !== 'object') {
                    continue;
                }
                const row = d as { uid?: string; title?: string; tags?: string[] };
                if (row.uid && row.title) {
                    hits.push({
                        uid: row.uid,
                        title: row.title,
                        tags: Array.isArray(row.tags) ? row.tags : undefined,
                    });
                }
            }
        }
    }

    if (hits.length === 0) {
        return parseSearchHitsFromMarkdownTable(text);
    }
    return hits;
}

function mergeSearchHits(existing: DashboardSearchHit[], more: DashboardSearchHit[]): DashboardSearchHit[] {
    const byUid = new Map(existing.map((h) => [h.uid, h]));
    for (const hit of more) {
        if (!byUid.has(hit.uid)) {
            byUid.set(hit.uid, hit);
        }
    }
    return Array.from(byUid.values());
}

/** Parse search_dashboards tool output / userReference for dashboard hits. */
export function parseSearchHitsFromToolExecutions(toolExecutions: ToolExecution[]): DashboardSearchHit[] {
    let hits: DashboardSearchHit[] = [];

    for (const step of toolExecutions) {
        if (step.name !== 'search_dashboards' && step.name !== 'search_folders') {
            continue;
        }
        const text = step.userReference ?? step.summary ?? '';
        hits = mergeSearchHits(hits, parseSearchHitsFromMcpText(text));
        hits = mergeSearchHits(hits, parseSearchHitsFromMarkdownTable(text));
    }

    return hits;
}

export function findDashboardByTitle(
    hits: DashboardSearchHit[],
    requestedTitle: string
): DashboardSearchHit | undefined {
    const want = requestedTitle.trim().toLowerCase();
    return hits.find((h) => h.title.toLowerCase() === want);
}

/**
 * Resolve a clone template label (machine id or dashboard name) without taking the
 * first substring hit (that copies the wrong dashboard when titles overlap).
 * Ambiguous matches return undefined so the caller can ask.
 * "Skywater FL" and "Skywater-FL" are treated as the same label.
 */
function foldDashboardLabel(value: string): string {
    return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function findBestDashboardHitForLabel(
    hits: DashboardSearchHit[],
    label: string
): DashboardSearchHit | undefined {
    const want = label.trim().toLowerCase();
    const wantFold = foldDashboardLabel(label);
    if (!want || !wantFold || hits.length === 0) {
        return undefined;
    }
    const exact = hits.filter((h) => foldDashboardLabel(h.title) === wantFold);
    if (exact.length === 1) {
        return exact[0];
    }
    const structured = hits.filter((h) => {
        const t = h.title.trim();
        const folded = foldDashboardLabel(t);
        if (folded === wantFold) {
            return true;
        }
        const parts = t.split('/');
        const last = parts[parts.length - 1] ?? '';
        const first = parts[0] ?? '';
        return foldDashboardLabel(last) === wantFold || foldDashboardLabel(first) === wantFold;
    });
    if (structured.length === 1) {
        return structured[0];
    }
    if (structured.length > 1) {
        return undefined;
    }
    return undefined;
}
