import { getBackendSrv } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';
import type { GrafanaEvalGroupIntervalRequest } from './grafanaAlertParse';
import {
    parseEvalIntervalSeconds,
    reconcilePendingWithEvalInterval,
} from './grafanaAlertBuild';

const PROVISION_HEADERS = {
    'X-Disable-Provenance': 'true',
    'Content-Type': 'application/json',
};

export interface ProgrammaticGrafanaEvalGroupIntervalResult {
    ok: boolean;
    error?: string;
    ruleGroup?: string;
    folderUID?: string;
    evalIntervalSeconds?: number;
    previousIntervalSeconds?: number;
    rulesPendingAdjusted?: number;
}

interface ProvisionedRuleRow {
    uid?: string;
    title?: string;
    folderUID?: string;
    ruleGroup?: string;
    for?: string;
    [key: string]: unknown;
}

function extractErrorMessage(err: unknown): string {
    if (!err) {
        return 'Unknown error';
    }
    if (typeof err === 'string') {
        return err;
    }
    const e = err as {
        message?: string;
        data?: { message?: string };
        status?: number;
        statusText?: string;
    };
    if (e.data?.message) {
        return e.data.message;
    }
    if (e.message) {
        return e.message;
    }
    if (e.status) {
        return `HTTP ${e.status}${e.statusText ? ` ${e.statusText}` : ''}`;
    }
    try {
        return JSON.stringify(err);
    } catch {
        return 'Unknown error';
    }
}

async function grafanaGet<T>(url: string): Promise<T> {
    const obs = getBackendSrv().fetch<T>({
        url,
        method: 'GET',
        showErrorAlert: false,
    });
    const res = await lastValueFrom(obs);
    return res.data;
}

async function grafanaPut<T>(url: string, data: unknown): Promise<T> {
    const obs = getBackendSrv().fetch<T>({
        url,
        method: 'PUT',
        data,
        headers: PROVISION_HEADERS,
        showErrorAlert: false,
    });
    const res = await lastValueFrom(obs);
    return res.data;
}

function findGroupFolder(
    rules: ProvisionedRuleRow[],
    ruleGroup: string
): { folderUID: string; sample?: ProvisionedRuleRow } | undefined {
    const want = ruleGroup.trim().toLowerCase();
    const hit = rules.find((r) => (r.ruleGroup ?? '').trim().toLowerCase() === want);
    if (hit?.folderUID?.trim()) {
        return { folderUID: hit.folderUID.trim(), sample: hit };
    }
    return undefined;
}

/**
 * Change the evaluation interval of an existing Grafana alert rule group by name.
 */
export async function runProgrammaticGrafanaEvalGroupInterval(
    request: GrafanaEvalGroupIntervalRequest,
    _buildNumber: number
): Promise<ProgrammaticGrafanaEvalGroupIntervalResult> {
    const ruleGroup = request.ruleGroup.trim();
    const evalIntervalSeconds = parseEvalIntervalSeconds(request.every);
    if (!ruleGroup) {
        return { ok: false, error: 'Missing evaluation group name.' };
    }

    let rules: ProvisionedRuleRow[];
    try {
        rules = await grafanaGet<ProvisionedRuleRow[]>('/api/v1/provisioning/alert-rules');
    } catch (err) {
        return {
            ok: false,
            error: `Could not list alert rules (need Alerting permissions): ${extractErrorMessage(err)}`,
        };
    }

    const located = findGroupFolder(rules, ruleGroup);
    if (!located) {
        const known = [
            ...new Set(
                rules
                    .map((r) => r.ruleGroup)
                    .filter((n): n is string => Boolean(n?.trim()))
                    .slice(0, 12)
            ),
        ];
        return {
            ok: false,
            error:
                `Evaluation group **${ruleGroup}** was not found` +
                (known.length
                    ? `. Known groups: ${known.map((g) => `\`${g}\``).join(', ')}.`
                    : '. No provisioned alert rule groups are visible in this org.'),
        };
    }

    const groupUrl = `/api/v1/provisioning/folder/${encodeURIComponent(located.folderUID)}/rule-groups/${encodeURIComponent(ruleGroup)}`;
    let previousIntervalSeconds: number | undefined;
    try {
        const group = await grafanaGet<{
            title?: string;
            folderUid?: string;
            interval?: number;
            rules?: unknown[];
        }>(groupUrl);
        previousIntervalSeconds =
            typeof group.interval === 'number' ? group.interval : undefined;
        await grafanaPut(groupUrl, {
            ...group,
            title: group.title ?? ruleGroup,
            folderUid: group.folderUid ?? located.folderUID,
            interval: evalIntervalSeconds,
        });
    } catch (err) {
        return {
            ok: false,
            error: `Could not update evaluation group **${ruleGroup}**: ${extractErrorMessage(err)}`,
        };
    }

    // Grafana requires pending (for) ≥ evaluation interval — raise any rules in the group that are short.
    let rulesPendingAdjusted = 0;
    const inGroup = rules.filter(
        (r) =>
            (r.ruleGroup ?? '').trim().toLowerCase() === ruleGroup.toLowerCase() &&
            (r.folderUID ?? '').trim() === located.folderUID &&
            r.uid
    );
    for (const rule of inGroup) {
        const currentFor = typeof rule.for === 'string' && rule.for.trim() ? rule.for : '1m';
        const reconciled = reconcilePendingWithEvalInterval(currentFor, evalIntervalSeconds);
        if (!reconciled.adjusted || !rule.uid) {
            continue;
        }
        try {
            const full = await grafanaGet<ProvisionedRuleRow>(
                `/api/v1/provisioning/alert-rules/${encodeURIComponent(rule.uid)}`
            );
            await grafanaPut(`/api/v1/provisioning/alert-rules/${encodeURIComponent(rule.uid)}`, {
                ...full,
                uid: full.uid ?? rule.uid,
                for: reconciled.pendingFor,
            });
            rulesPendingAdjusted += 1;
        } catch {
            // Best-effort — group interval already saved.
        }
    }

    // Verify group interval.
    try {
        const verified = await grafanaGet<{ interval?: number }>(groupUrl);
        if (verified.interval !== evalIntervalSeconds) {
            return {
                ok: false,
                error:
                    `Update appeared to succeed but group **${ruleGroup}** still reports interval ` +
                    `${verified.interval ?? '?'}s (expected ${evalIntervalSeconds}s).`,
            };
        }
    } catch (err) {
        return {
            ok: false,
            error: `Update appeared to succeed but verification failed: ${extractErrorMessage(err)}`,
        };
    }

    return {
        ok: true,
        ruleGroup,
        folderUID: located.folderUID,
        evalIntervalSeconds,
        previousIntervalSeconds,
        rulesPendingAdjusted,
    };
}

export function formatGrafanaEvalGroupIntervalReply(
    result: ProgrammaticGrafanaEvalGroupIntervalResult,
    buildNumber: number
): string {
    if (!result.ok) {
        return (
            `### Could not change evaluation interval (build ${buildNumber})\n\n` +
            `${result.error ?? 'Unknown error'}\n\n` +
            `Tip: name the group exactly (e.g. \`Change the Evaluation Interval of 'Test Eval Group' to be 2 minutes.\`).`
        );
    }

    return (
        `### Evaluation interval updated (build ${buildNumber})\n\n` +
        `**Saved** — group **${result.ruleGroup}**` +
        (result.folderUID ? ` (folder \`${result.folderUID}\`)` : '') +
        `.\n\n` +
        `- **Evaluate:** every **${result.evalIntervalSeconds}s**` +
        (result.previousIntervalSeconds != null &&
        result.previousIntervalSeconds !== result.evalIntervalSeconds
            ? ` _(was ${result.previousIntervalSeconds}s)_`
            : '') +
        `\n` +
        (result.rulesPendingAdjusted
            ? `- **Pending periods:** raised on **${result.rulesPendingAdjusted}** rule(s) so pending ≥ evaluation interval\n`
            : '') +
        `\nOpen **Alerts & IRM → Alert rules** → group **${result.ruleGroup}** to confirm.`
    );
}
