import { getBackendSrv, config } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';
import type { GrafanaAlertCreateRequest } from './grafanaAlertParse';
import { formatGrafanaAlertGuidanceReply } from './grafanaAlertParse';
import {
    buildBandBreachAlertQueries,
    buildProvisionedAlertRuleBody,
    defaultAlertRuleGroup,
    defaultAlertRuleTitle,
    matchContactPointName,
    parseEvalIntervalSeconds,
} from './grafanaAlertBuild';
import { findPanelByStrictTitle, listDashboardPanels } from './panelDiscovery';

const PROVISION_HEADERS = {
    'X-Disable-Provenance': 'true',
    'Content-Type': 'application/json',
};

export interface ProgrammaticGrafanaAlertCreateResult {
    ok: boolean;
    error?: string;
    /** When create fails, UI steps for manual setup. */
    guidance?: string;
    alreadyExists?: boolean;
    updated?: boolean;
    ruleUid?: string;
    ruleTitle?: string;
    ruleGroup?: string;
    folderUID?: string;
    contactPoint?: string;
    contactPointCreated?: boolean;
    dashboardUid?: string;
    dashboardTitle?: string;
    panelTitle?: string;
    panelId?: number;
    mathExpression?: string;
    evalIntervalSeconds?: number;
    pendingFor?: string;
    /** True when Flux was rewritten to `_time`/`_value` (no output `_field` labels). */
    alertCompatibleQueries?: boolean;
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
        data?: { message?: string; messageId?: string };
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

interface DashboardApiResponse {
    dashboard?: Record<string, unknown>;
    meta?: { folderUid?: string; folderTitle?: string };
}

interface ContactPointRow {
    uid?: string;
    name?: string;
    type?: string;
}

interface ProvisionedRuleRow {
    uid?: string;
    title?: string;
    folderUID?: string;
    ruleGroup?: string;
    annotations?: Record<string, string>;
}

async function createEmailContactPoint(
    name: string,
    email: string
): Promise<{ name: string } | { error: string }> {
    const body = {
        name,
        type: 'email',
        settings: { addresses: email },
        disableResolveMessage: false,
    };
    try {
        await grafanaPost('/api/v1/provisioning/contact-points', body);
        return { name };
    } catch (err) {
        return {
            error: `Could not create email contact point **${name}** (${email}): ${extractErrorMessage(err)}`,
        };
    }
}

function findExistingPanelAlertRule(
    existing: ProvisionedRuleRow[],
    opts: { ruleTitle: string; ruleGroup: string; folderUID: string; dashboardUid: string; panelId: number }
): ProvisionedRuleRow | undefined {
    const byGroup = existing.find(
        (r) =>
            (r.title ?? '') === opts.ruleTitle &&
            (r.folderUID ?? '') === opts.folderUID &&
            (r.ruleGroup ?? '') === opts.ruleGroup
    );
    if (byGroup) {
        return byGroup;
    }
    // Match linked panel even if title/group drifted from an earlier Graft create.
    return existing.find(
        (r) =>
            (r.annotations?.__dashboardUid__ ?? '') === opts.dashboardUid &&
            (r.annotations?.__panelId__ ?? '') === String(opts.panelId)
    );
}


/**
 * Create a Grafana-managed alert from an Own History ±2σ panel via the provisioning API.
 * Uses the signed-in user's Grafana session (getBackendSrv) — not MCP.
 */
export async function runProgrammaticGrafanaAlertCreate(
    request: GrafanaAlertCreateRequest,
    buildNumber: number
): Promise<ProgrammaticGrafanaAlertCreateResult> {
    const guidanceBase = (error: string): ProgrammaticGrafanaAlertCreateResult => ({
        ok: false,
        error,
        guidance: formatGrafanaAlertGuidanceReply(request, buildNumber, error),
    });

    const dashboardUid = request.dashboardUid?.trim();
    if (!dashboardUid) {
        return guidanceBase('Missing dashboard UID. Include `dashboard with UID = …` in the prompt.');
    }
    if (!request.panelTitle?.trim()) {
        return guidanceBase('Missing panel title. Include `panel titled "…"` in the prompt.');
    }

    let dashResp: DashboardApiResponse;
    try {
        dashResp = await grafanaGet<DashboardApiResponse>(`/api/dashboards/uid/${dashboardUid}`);
    } catch (err) {
        return guidanceBase(`Could not load dashboard \`${dashboardUid}\`: ${extractErrorMessage(err)}`);
    }

    const dashboard = dashResp.dashboard;
    if (!dashboard) {
        return guidanceBase(`Dashboard \`${dashboardUid}\` returned no dashboard JSON.`);
    }

    const dashboardTitle =
        typeof dashboard.title === 'string' ? dashboard.title : undefined;
    const folderUID = (dashResp.meta?.folderUid ?? '').trim();
    // General folder is empty string in some versions; provisioning wants a real folder UID.
    // Fall back to searching alert folders if missing.
    let resolvedFolder = folderUID;
    if (!resolvedFolder) {
        try {
            const folders = await grafanaGet<Array<{ uid?: string; title?: string }>>('/api/folders');
            const preferred =
                folders.find((f) => /keysight|alerting|alerts/i.test(f.title ?? '')) ?? folders[0];
            resolvedFolder = preferred?.uid?.trim() ?? '';
        } catch {
            // leave empty
        }
    }
    if (!resolvedFolder) {
        return guidanceBase(
            'Dashboard is in the General folder and no alternate folder UID was found. ' +
                'Move the dashboard into a folder (or create an alert folder), then retry.'
        );
    }

    const entries = listDashboardPanels(dashboard.panels);
    const hit = findPanelByStrictTitle(entries, request.panelTitle);
    if (!hit) {
        return guidanceBase(
            `Panel titled **${request.panelTitle}** was not found on dashboard \`${dashboardUid}\`.`
        );
    }
    if (hit.panelId == null) {
        return guidanceBase(`Panel **${hit.title}** has no panel id (cannot link annotations).`);
    }

    const built = buildBandBreachAlertQueries(hit.panel as Record<string, unknown>);
    if ('error' in built) {
        return guidanceBase(built.error);
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
                // Prompt asked to create a new email contact point — provision it now.
                const created = await createEmailContactPoint(
                    request.contactPoint.trim(),
                    request.contactPointEmail.trim()
                );
                if ('error' in created) {
                    return guidanceBase(created.error);
                }
                contactPointName = created.name;
                contactPointCreated = true;
            } else {
                const names = points
                    .map((p) => p.name)
                    .filter((n): n is string => Boolean(n))
                    .slice(0, 12);
                return guidanceBase(
                    `Contact point **${request.contactPoint}** was not found. ` +
                        (names.length
                            ? `Available: ${names.map((n) => `\`${n}\``).join(', ')}. `
                            : 'No contact points are configured in this org. ') +
                        'Add an email address to the prompt (e.g. `using alex@example.com`) and Graft will create it.'
                );
            }
        } catch (err) {
            return guidanceBase(
                `Could not list/create contact points (need Alerting permissions): ${extractErrorMessage(err)}`
            );
        }
    }

    const ruleTitle = defaultAlertRuleTitle(hit.title);
    const ruleGroup = defaultAlertRuleGroup(dashboardUid, hit.panelId);
    const evalIntervalSeconds = parseEvalIntervalSeconds(request.every);
    const orgId = Number(config.bootData?.user?.orgId ?? 1);

    let priorUid: string | undefined;
    try {
        const existing = await grafanaGet<ProvisionedRuleRow[]>('/api/v1/provisioning/alert-rules');
        const prior = findExistingPanelAlertRule(existing, {
            ruleTitle,
            ruleGroup,
            folderUID: resolvedFolder,
            dashboardUid,
            panelId: hit.panelId,
        });
        priorUid = prior?.uid;
    } catch {
        // Listing may fail without full read ACL — still try create.
    }

    const body = buildProvisionedAlertRuleBody({
        request,
        title: ruleTitle,
        ruleGroup,
        folderUID: resolvedFolder,
        orgId,
        panelId: hit.panelId,
        dashboardUid,
        data: built.data,
        condition: built.condition,
        contactPointName,
        uid: priorUid,
    });

    let saved: ProvisionedRuleRow;
    let updated = false;
    try {
        if (priorUid) {
            saved = await grafanaPut<ProvisionedRuleRow>(
                `/api/v1/provisioning/alert-rules/${encodeURIComponent(priorUid)}`,
                body
            );
            updated = true;
        } else {
            saved = await grafanaPost<ProvisionedRuleRow>('/api/v1/provisioning/alert-rules', body);
        }
    } catch (err) {
        return guidanceBase(
            `Alert rule ${priorUid ? 'update' : 'create'} failed: ${extractErrorMessage(err)}`
        );
    }

    // Ensure the rule group evaluates at the requested interval (default new groups are often 60s).
    try {
        const groupUrl = `/api/v1/provisioning/folder/${encodeURIComponent(resolvedFolder)}/rule-groups/${encodeURIComponent(ruleGroup)}`;
        const group = await grafanaGet<{
            title?: string;
            folderUid?: string;
            interval?: number;
            rules?: unknown[];
        }>(groupUrl);
        if (group && group.interval !== evalIntervalSeconds) {
            await grafanaPut(groupUrl, {
                ...group,
                title: group.title ?? ruleGroup,
                folderUid: group.folderUid ?? resolvedFolder,
                interval: evalIntervalSeconds,
            });
        }
    } catch {
        // Interval update is best-effort; rule create/update already succeeded.
    }

    return {
        ok: true,
        updated,
        alreadyExists: updated,
        ruleUid: saved.uid ?? priorUid,
        ruleTitle,
        ruleGroup,
        folderUID: resolvedFolder,
        contactPoint: contactPointName,
        contactPointCreated,
        dashboardUid,
        dashboardTitle,
        panelTitle: hit.title,
        panelId: hit.panelId,
        mathExpression: built.mathExpression,
        evalIntervalSeconds,
        pendingFor: request.pendingFor ?? '1m',
        alertCompatibleQueries: true,
    };
}

export function formatGrafanaAlertCreateReply(
    result: ProgrammaticGrafanaAlertCreateResult,
    buildNumber: number
): string {
    if (!result.ok) {
        return (
            result.guidance ??
            `### Could not create Grafana alert (build ${buildNumber})\n\n${result.error ?? 'Unknown error'}`
        );
    }

    const headline = result.updated
        ? `### Grafana alert updated (build ${buildNumber})\n\n**Updated** — `
        : `### Grafana alert created (build ${buildNumber})\n\n**Saved** — `;

    return (
        headline +
        `rule **${result.ruleTitle}**` +
        (result.ruleUid ? ` (\`${result.ruleUid}\`)` : '') +
        `.\n\n` +
        `- **Panel:** ${result.panelTitle}` +
        (result.panelId != null ? ` (id ${result.panelId})` : '') +
        `\n` +
        `- **Dashboard:** ${result.dashboardTitle ?? result.dashboardUid}` +
        (result.dashboardUid ? ` (\`${result.dashboardUid}\`)` : '') +
        `\n` +
        `- **Condition:** \`${result.mathExpression ?? '$E > $F || $E < $G'}\` ` +
        `(Last Actual vs Upper/Lower)\n` +
        `- **Evaluate:** every **${result.evalIntervalSeconds ?? 60}s** · pending **${result.pendingFor ?? '1m'}**\n` +
        (result.contactPoint
            ? `- **Contact point:** **${result.contactPoint}**${result.contactPointCreated ? ' _(newly created email contact point)_' : ''}\n`
            : `- **Contact point:** _(not set — routed by default notification policy)_\n`) +
        `- **Rule group:** \`${result.ruleGroup}\` · folder \`${result.folderUID}\`\n` +
        (result.alertCompatibleQueries
            ? `- **Alert queries:** rewritten to numeric \`_time\`/\`_value\` series (24h lookback for ±2σ hourly bands)\n`
            : '') +
        `\nOpen **Alerts & IRM → Alert rules** → Preview. Confirm Math \`H\` is \`1\` when Actual is outside the band, then wait ≥ pending period for email.`
    );
}
