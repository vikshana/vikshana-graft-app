import { targetDatasourceType } from './fluxPeerBandFix';

type PanelRecord = Record<string, unknown>;

export interface PanelFluxIssue {
    refId: string;
    legend?: string;
    issue: string;
}

function targetRefId(target: PanelRecord): string {
    return typeof target.refId === 'string' && target.refId.trim() ? target.refId.trim() : '?';
}

function targetLegend(target: PanelRecord): string | undefined {
    return typeof target.legendFormat === 'string' && target.legendFormat.trim()
        ? target.legendFormat.trim()
        : undefined;
}

function queryFromTarget(target: PanelRecord): string {
    for (const field of ['query', 'expr', 'rawQuery', 'queryText']) {
        const raw = target[field];
        if (typeof raw === 'string' && raw.trim()) {
            return raw;
        }
    }
    return '';
}

function isPeerBandQueryTarget(refId: string, legend?: string): boolean {
    return (
        refId === 'B' ||
        refId === 'C' ||
        refId === 'D' ||
        /peer avg|upper band|lower band/i.test(String(legend ?? ''))
    );
}

/** Static checks on saved Flux text — does not execute queries in Grafana/Influx. */
export function scanPanelFluxIssues(panel: PanelRecord): PanelFluxIssue[] {
    const issues: PanelFluxIssue[] = [];
    const targets = panel.targets;
    if (!Array.isArray(targets)) {
        return issues;
    }

    for (const t of targets) {
        if (!t || typeof t !== 'object') {
            continue;
        }
        const target = t as PanelRecord;
        const query = queryFromTarget(target);
        if (!query) {
            continue;
        }
        const refId = targetRefId(target);
        const legend = targetLegend(target);

        if (
            /\bfrom\s*\(\s*bucket:/i.test(query) &&
            (targetDatasourceType(target) === 'prometheus' || targetDatasourceType(target) === '')
        ) {
            issues.push({
                refId,
                legend,
                issue:
                    'Flux query on Prometheus (or missing) datasource — causes parse error unexpected identifier "v"; copy datasource from a working Influx/Flux panel on this dashboard',
            });
        }

        if (/\bfrom\s*\(\s*bucket:/i.test(query)) {
            if (typeof target.expr === 'string' && target.expr.trim()) {
                issues.push({
                    refId,
                    legend,
                    issue:
                        'Flux is in expr without a proper Influx target shape — move Flux to query, set rawQuery:true, delete expr (fixes unexpected identifier "v")',
                });
            } else if (typeof target.query !== 'string' || !target.query.trim()) {
                issues.push({
                    refId,
                    legend,
                    issue: 'missing query field for Flux — set query to the Flux script and rawQuery:true',
                });
            } else if (target.rawQuery !== true && typeof target.rawQuery !== 'string') {
                issues.push({
                    refId,
                    legend,
                    issue: 'Influx Flux target should set rawQuery:true (code mode)',
                });
            }
        }

        if (/\bstdDev\b/.test(query)) {
            issues.push({ refId, legend, issue: 'uses invalid token stdDev (use stddev or manual stats)' });
        }
        if (/\br\._field\s*=~\s*"/.test(query)) {
            issues.push({ refId, legend, issue: 'r._field =~ uses a string — Flux requires a regex literal /pattern/' });
        }
        if (/\|\>\s*filter\s*\(\s*fn:\s*\(\s*r\s*\|>/i.test(query)) {
            issues.push({ refId, legend, issue: 'filter() clause is corrupted (aggregateWindow inserted inside filter)' });
        }
        if (/\bmean_val\b/.test(query)) {
            issues.push({ refId, legend, issue: 'uses invalid token mean_val' });
        }
        if (/\bgroup\s*\(\s*by\s*:/i.test(query) || /\|\>\s*group\s*\(\s*by\b/i.test(query)) {
            issues.push({ refId, legend, issue: 'uses group(by:) — Flux expects group(columns: [...])' });
        }
        if (/\|\>\s*reduce\s*\([^)]*\bfn\s*:\s*\(\s*acc\s*,/is.test(query)) {
            issues.push({
                refId,
                legend,
                issue: 'reduce() uses (acc, r) — Flux expects (r, accumulator)',
            });
        }

        if (refId === 'A' || /module\s*5.*actual/i.test(String(legend ?? ''))) {
            if (/\br\._measurement\s*==\s*"machine_metrics"/i.test(query)) {
                issues.push({
                    refId,
                    legend,
                    issue:
                        'r._measurement == "machine_metrics" often matches nothing in Flux (PromQL name) — use r.machine and r._field only',
                });
            } else if (/\|\>\s*mean\s*\(\s*\)/i.test(query)) {
                issues.push({
                    refId,
                    legend,
                    issue:
                        'target A uses bare |> mean() which drops _time — use filter + keep(columns: ["_time", "_value"]) only',
                });
            } else if (!/\|\>\s*keep\s*\(/i.test(query)) {
                issues.push({
                    refId,
                    legend,
                    issue: 'target A missing |> keep(columns: ["_time", "_value"]) after filter',
                });
            }
            continue;
        }

        if (!isPeerBandQueryTarget(refId, legend)) {
            continue;
        }

        if (/\br\._field\s*=~/.test(query)) {
            issues.push({
                refId,
                legend,
                issue:
                    'uses r._field =~ regex — use one filter with (r._field == "Module1..." or ...) and keep() to avoid max series (1000)',
            });
        } else if (/\br\._measurement\s*==\s*"machine_metrics"/i.test(query)) {
            issues.push({
                refId,
                legend,
                issue: 'remove r._measurement == "machine_metrics" — use r.machine + r._field (matches working panels)',
            });
        } else if (/\bor\b/i.test(query) && (query.match(/r\._field\s*==\s*"Module\d+_Current_A"/g) ?? []).length >= 2) {
            issues.push({
                refId,
                legend,
                issue:
                    'OR filter on multiple _field values scans 1000+ series — use union(tables:) with one branch per module and keep() after each filter',
            });
        } else if (!/\bunion\s*\(\s*tables\s*:/i.test(query)) {
            issues.push({
                refId,
                legend,
                issue:
                    'peer/band query should use union(tables:) with one collapsed branch per peer module (filter + keep per field)',
            });
        } else if (!/\|\>\s*keep\s*\(/i.test(query)) {
            issues.push({
                refId,
                legend,
                issue: 'union branches missing |> keep(columns: ["_time", "_value"]) after filter',
            });
        }
    }

    return issues;
}

export function formatPanelVerificationBlock(
    issues: PanelFluxIssue[],
    options?: { savedVersion?: number }
): string {
    if (issues.length === 0) {
        const versionBit =
            options?.savedVersion != null ? ` Dashboard version **${options.savedVersion}**.` : '';
        return (
            `**Saved (syntax check only):** A/B–D filter \`r.machine\` + \`r._field\` only (no \`r._measurement\` — PromQL \`machine_metrics\` is not an Influx measurement); B–D use \`union\` + \`group()\` + \`keep\` + \`aggregateWindow\` per branch.${versionBit} ` +
            `Graft did **not** execute these queries — open target A and confirm **no** \`r._measurement == "machine_metrics"\`. ` +
            `Then hard-refresh the dashboard. If Status 500 remains, paste the error here.`
        );
    }

    const lines = issues.map((i) => {
        const label = i.legend ? `Target **${i.refId}** (${i.legend})` : `Target **${i.refId}**`;
        return `- ${label}: ${i.issue}`;
    });
    return `**Save blocked (syntax check):**\n${lines.join('\n')}`;
}
