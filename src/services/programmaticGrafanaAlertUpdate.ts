import { getBackendSrv } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';
import type { GrafanaAlertUpdateRequest } from './grafanaAlertParse';
import { matchContactPointName } from './grafanaAlertBuild';

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

function findRuleByTitle(existing: ProvisionedRuleRow[], title: string): ProvisionedRuleRow | undefined {
    const want = title.trim().toLowerCase();
    const exact = existing.find((r) => (r.title ?? '').trim().toLowerCase() === want);
    if (exact) {
        return exact;
    }
    return existing.find((r) => {
        const n = (r.title ?? '').trim().toLowerCase();
        return n.includes(want) || want.includes(n);
    });
}

/**
 * Patch labels / annotations / contact point on an existing Grafana-managed alert by title.
 * Intended for small follow-up prompts after a create (avoids needing dashboard UID + panel).
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

    const prior = findRuleByTitle(existing, ruleTitle);
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

    const body: Record<string, unknown> = {
        ...full,
        uid: full.uid ?? prior.uid,
        title: full.title ?? ruleTitle,
        labels: nextLabels,
        annotations: nextAnnotations,
    };
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

    // Verify the write stuck.
    try {
        const verified = await grafanaGet<ProvisionedRuleRow>(
            `/api/v1/provisioning/alert-rules/${encodeURIComponent(prior.uid)}`
        );
        if (!verified?.uid) {
            return {
                ok: false,
                error: `Update appeared to succeed but rule **${ruleTitle}** (\`${prior.uid}\`) could not be verified.`,
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
        ruleGroup: full.ruleGroup ?? prior.ruleGroup,
        folderUID: full.folderUID ?? prior.folderUID,
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
            `as a small follow-up — labels / summary / description / annotations / contact point only.`
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

    return (
        `### Grafana alert updated (build ${buildNumber})\n\n` +
        `**Updated** — rule **${result.ruleTitle}**` +
        (result.ruleUid ? ` (\`${result.ruleUid}\`)` : '') +
        `.\n\n` +
        contactLine +
        (result.ruleGroup ? `- **Rule group:** \`${result.ruleGroup}\`` : '') +
        (result.folderUID ? ` · folder \`${result.folderUID}\`` : '') +
        (result.ruleGroup || result.folderUID ? `\n` : '') +
        labelLine +
        summaryLine +
        descriptionLine +
        customAnnLine +
        `\nOpen **Alerts & IRM → Alert rules** → **${result.ruleTitle}** to confirm labels, annotations, and notifications.`
    );
}
