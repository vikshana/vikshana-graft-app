import { getBackendSrv } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';
import type { GrafanaAlertUpdateRequest } from './grafanaAlertParse';
import {
    matchContactPointName,
    parseEvalIntervalSeconds,
    reconcilePendingWithEvalInterval,
} from './grafanaAlertBuild';

const PROVISION_HEADERS = {
    'X-Disable-Provenance': 'true',
    'Content-Type': 'application/json',
};

export interface ProgrammaticGrafanaAlertUpdateResult {
    ok: boolean;
    error?: string;
    ruleUid?: string;
    ruleTitle?: string;
    ruleGroup?: string;
    ruleGroupMoved?: boolean;
    evalIntervalSeconds?: number;
    pendingFor?: string;
    pendingAdjusted?: boolean;
    folderUID?: string;
    contactPoint?: string;
    contactPointCreated?: boolean;
    labels?: Record<string, string>;
    summary?: string;
    description?: string;
    customAnnotations?: Record<string, string>;
}

interface ProvisionedRuleRow {
    uid?: string;
    title?: string;
    folderUID?: string;
    ruleGroup?: string;
    for?: string;
    annotations?: Record<string, string>;
    labels?: Record<string, string>;
    notification_settings?: { receiver?: string };
    [key: string]: unknown;
}

interface ContactPointRow {
    uid?: string;
    name?: string;
    type?: string;
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

async function grafanaPost<T>(url: string, data: unknown): Promise<T> {
    const obs = getBackendSrv().fetch<T>({
        url,
        method: 'POST',
        data,
        headers: PROVISION_HEADERS,
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

async function createEmailContactPoint(
    name: string,
    email: string
): Promise<{ name: string } | { error: string }> {
    try {
        await grafanaPost('/api/v1/provisioning/contact-points', {
            name,
            type: 'email',
            settings: { addresses: email },
            disableResolveMessage: false,
        });
        return { name };
    } catch (err) {
        return {
            error: `Could not create email contact point **${name}** (${email}): ${extractErrorMessage(err)}`,
        };
    }
}

function findRuleByTitle(
    existing: ProvisionedRuleRow[],
    title: string,
    opts?: { dashboardUid?: string; panelTitle?: string }
): ProvisionedRuleRow | undefined {
    const want = title.trim().toLowerCase();
    const byTitle = existing.filter((r) => {
        const n = (r.title ?? '').trim().toLowerCase();
        return n === want || n.includes(want) || want.includes(n);
    });
    if (byTitle.length === 0) {
        return undefined;
    }
    if (byTitle.length === 1) {
        return byTitle[0];
    }
    const dash = opts?.dashboardUid?.trim();
    if (dash) {
        const onDash = byTitle.filter((r) => (r.annotations?.__dashboardUid__ ?? '') === dash);
        if (onDash.length === 1) {
            return onDash[0];
        }
        if (onDash.length > 1) {
            return onDash[0];
        }
    }
    // Prefer exact title match when several partial matches exist.
    const exact = byTitle.find((r) => (r.title ?? '').trim().toLowerCase() === want);
    return exact ?? byTitle[0];
}

/**
 * Patch labels / annotations / contact point / evaluation group on an existing
 * Grafana-managed alert by title. Intended for small follow-up prompts after a create.
 */
export async function runProgrammaticGrafanaAlertUpdate(
    request: GrafanaAlertUpdateRequest,
    _buildNumber: number
): Promise<ProgrammaticGrafanaAlertUpdateResult> {
    const ruleTitle = request.ruleTitle.trim();
    if (!ruleTitle) {
        return { ok: false, error: 'Missing alert rule name. Include `alert rule named …` in the prompt.' };
    }

    let existing: ProvisionedRuleRow[];
    try {
        existing = await grafanaGet<ProvisionedRuleRow[]>('/api/v1/provisioning/alert-rules');
    } catch (err) {
        return {
            ok: false,
            error: `Could not list alert rules (need Alerting permissions): ${extractErrorMessage(err)}`,
        };
    }

    const prior = findRuleByTitle(existing, ruleTitle, {
        dashboardUid: request.dashboardUid,
        panelTitle: request.panelTitle,
    });
    if (!prior?.uid) {
        return {
            ok: false,
            error:
                `Alert rule **${ruleTitle}** was not found. ` +
                `Create it first (include panel + dashboard UID), then re-run this update prompt.`,
        };
    }

    let full: ProvisionedRuleRow;
    try {
        full = await grafanaGet<ProvisionedRuleRow>(
            `/api/v1/provisioning/alert-rules/${encodeURIComponent(prior.uid)}`
        );
    } catch (err) {
        return {
            ok: false,
            error: `Could not load alert rule \`${prior.uid}\`: ${extractErrorMessage(err)}`,
        };
    }

    let contactPointName: string | undefined;
    let contactPointCreated = false;
    if (request.contactPoint?.trim()) {
        try {
            const points = await grafanaGet<ContactPointRow[]>('/api/v1/provisioning/contact-points');
            const matched = matchContactPointName(points, request.contactPoint);
            if (matched) {
                contactPointName = matched;
            } else if (request.contactPointEmail?.trim()) {
                const created = await createEmailContactPoint(
                    request.contactPoint.trim(),
                    request.contactPointEmail.trim()
                );
                if ('error' in created) {
                    return { ok: false, error: created.error };
                }
                contactPointName = created.name;
                contactPointCreated = true;
            } else {
                const names = points
                    .map((p) => p.name)
                    .filter((n): n is string => Boolean(n))
                    .slice(0, 12);
                return {
                    ok: false,
                    error:
                        `Contact point **${request.contactPoint}** was not found. ` +
                        (names.length
                            ? `Available: ${names.map((n) => `\`${n}\``).join(', ')}.`
                            : 'No contact points are configured in this org.'),
                };
            }
        } catch (err) {
            return {
                ok: false,
                error: `Could not list/create contact points: ${extractErrorMessage(err)}`,
            };
        }
    }

    const nextLabels: Record<string, string> = request.restrictMetadata
        ? { ...(request.labels ?? {}) }
        : { ...(full.labels ?? {}), ...(request.labels ?? {}) };

    const nextAnnotations: Record<string, string> = request.restrictMetadata
        ? {}
        : { ...(full.annotations ?? {}) };
    if (request.summary?.trim()) {
        nextAnnotations.summary = request.summary.trim();
    }
    if (request.description?.trim()) {
        nextAnnotations.description = request.description.trim();
    }
    if (request.customAnnotations) {
        for (const [k, v] of Object.entries(request.customAnnotations)) {
            if (k.trim() && v != null) {
                nextAnnotations[k.trim()] = String(v);
            }
        }
    }

    const targetGroup = request.ruleGroup?.trim();
    const previousGroup = (full.ruleGroup ?? prior.ruleGroup ?? '').trim();
    const nextGroup = targetGroup || previousGroup;
    const ruleGroupMoved = Boolean(targetGroup && targetGroup !== previousGroup);
    const folderUID = (full.folderUID ?? prior.folderUID ?? '').trim();
    const evalIntervalSeconds = request.every
        ? parseEvalIntervalSeconds(request.every)
        : undefined;

    // Grafana requires pending (for) ≥ evaluation interval when we change the group interval.
    let pendingFor: string | undefined;
    let pendingAdjusted = false;
    if (evalIntervalSeconds != null) {
        const currentFor =
            typeof full.for === 'string' && full.for.trim() ? String(full.for) : '1m';
        const reconciled = reconcilePendingWithEvalInterval(currentFor, evalIntervalSeconds);
        pendingFor = reconciled.pendingFor;
        pendingAdjusted = reconciled.adjusted;
    }

    const body: Record<string, unknown> = {
        ...full,
        uid: full.uid ?? prior.uid,
        title: full.title ?? ruleTitle,
        labels: nextLabels,
        annotations: nextAnnotations,
    };
    if (nextGroup) {
        body.ruleGroup = nextGroup;
    }
    if (pendingFor) {
        body.for = pendingFor;
    }
    if (contactPointName) {
        body.notification_settings = {
            ...(typeof full.notification_settings === 'object' && full.notification_settings
                ? full.notification_settings
                : {}),
            receiver: contactPointName,
        };
    }

    try {
        await grafanaPut(
            `/api/v1/provisioning/alert-rules/${encodeURIComponent(prior.uid)}`,
            body
        );
    } catch (err) {
        return {
            ok: false,
            error: `Alert rule update failed: ${extractErrorMessage(err)}`,
        };
    }

    // Set/create the evaluation group interval after the rule is in that group.
    if (nextGroup && folderUID && evalIntervalSeconds != null) {
        try {
            const groupUrl = `/api/v1/provisioning/folder/${encodeURIComponent(folderUID)}/rule-groups/${encodeURIComponent(nextGroup)}`;
            let group: {
                title?: string;
                folderUid?: string;
                interval?: number;
                rules?: unknown[];
            };
            try {
                group = await grafanaGet(groupUrl);
            } catch {
                group = {
                    title: nextGroup,
                    folderUid: folderUID,
                    interval: evalIntervalSeconds,
                    rules: [],
                };
            }
            if (group.interval !== evalIntervalSeconds || ruleGroupMoved) {
                await grafanaPut(groupUrl, {
                    ...group,
                    title: group.title ?? nextGroup,
                    folderUid: group.folderUid ?? folderUID,
                    interval: evalIntervalSeconds,
                });
            }
        } catch (err) {
            return {
                ok: false,
                error:
                    `Moved rule to group **${nextGroup}** but could not set evaluation interval ` +
                    `to ${evalIntervalSeconds}s: ${extractErrorMessage(err)}`,
            };
        }
    }

    // Verify the write stuck (and that the rule is in the target group when requested).
    let verified: ProvisionedRuleRow | undefined;
    try {
        verified = await grafanaGet<ProvisionedRuleRow>(
            `/api/v1/provisioning/alert-rules/${encodeURIComponent(prior.uid)}`
        );
        if (!verified?.uid) {
            return {
                ok: false,
                error: `Update appeared to succeed but rule **${ruleTitle}** (\`${prior.uid}\`) could not be verified.`,
            };
        }
        if (targetGroup && (verified.ruleGroup ?? '') !== targetGroup) {
            return {
                ok: false,
                error:
                    `Rule **${ruleTitle}** is still in group \`${verified.ruleGroup ?? '(none)'}\` ` +
                    `instead of **${targetGroup}**. Try again or move it in the Grafana UI.`,
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
        ruleUid: prior.uid,
        ruleTitle: full.title ?? ruleTitle,
        ruleGroup: verified?.ruleGroup || nextGroup || previousGroup || undefined,
        ruleGroupMoved,
        evalIntervalSeconds,
        pendingFor,
        pendingAdjusted,
        folderUID: folderUID || undefined,
        contactPoint: contactPointName,
        contactPointCreated,
        labels: request.labels,
        summary: request.summary,
        description: request.description,
        customAnnotations: request.customAnnotations,
    };
}

export function formatGrafanaAlertUpdateReply(
    result: ProgrammaticGrafanaAlertUpdateResult,
    buildNumber: number
): string {
    if (!result.ok) {
        return (
            `### Could not update Grafana alert (build ${buildNumber})\n\n` +
            `${result.error ?? 'Unknown error'}\n\n` +
            `Tip: name the existing rule exactly (\`alert rule named GraftAI Rule\`) and keep this ` +
            `as a small follow-up — labels / annotations / contact point / evaluation group.`
        );
    }

    const labelLine =
        result.labels && Object.keys(result.labels).length > 0
            ? `- **Labels added/set:** ${Object.entries(result.labels)
                  .map(([k, v]) => `\`${k}=${v}\``)
                  .join(', ')}\n`
            : '';
    const summaryLine = result.summary ? `- **Summary:** ${result.summary}\n` : '';
    const descriptionLine = result.description ? `- **Description:** ${result.description}\n` : '';
    const customAnnLine =
        result.customAnnotations && Object.keys(result.customAnnotations).length > 0
            ? `- **Custom annotations:** ${Object.entries(result.customAnnotations)
                  .map(([k, v]) => `\`${k}\` = ${v}`)
                  .join('; ')}\n`
            : '';
    const contactLine = result.contactPoint
        ? `- **Contact point:** **${result.contactPoint}**${
              result.contactPointCreated ? ' _(newly created)_' : ''
          }\n`
        : '';
    const groupLine = result.ruleGroup
        ? `- **Rule group:** \`${result.ruleGroup}\`` +
          (result.ruleGroupMoved ? ' _(moved into this evaluation group)_' : '') +
          (result.folderUID ? ` · folder \`${result.folderUID}\`` : '') +
          `\n`
        : result.folderUID
          ? `- **Folder:** \`${result.folderUID}\`\n`
          : '';
    const evalLine =
        result.evalIntervalSeconds != null
            ? `- **Evaluate:** every **${result.evalIntervalSeconds}s**` +
              (result.pendingFor
                  ? ` · pending **${result.pendingFor}**` +
                    (result.pendingAdjusted
                        ? ' _(raised so pending ≥ evaluation interval)_'
                        : '')
                  : '') +
              `\n`
            : '';

    return (
        `### Grafana alert updated (build ${buildNumber})\n\n` +
        `**Updated** — rule **${result.ruleTitle}**` +
        (result.ruleUid ? ` (\`${result.ruleUid}\`)` : '') +
        `.\n\n` +
        contactLine +
        groupLine +
        evalLine +
        labelLine +
        summaryLine +
        descriptionLine +
        customAnnLine +
        `\nOpen **Alerts & IRM → Alert rules** → **${result.ruleTitle}** to confirm the evaluation group, labels, annotations, and notifications.`
    );
}
