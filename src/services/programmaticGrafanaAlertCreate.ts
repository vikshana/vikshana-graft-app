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
    ruleUid?: string;
    ruleTitle?: string;
    ruleGroup?: string;
    folderUID?: string;
    contactPoint?: string;
    dashboardUid?: string;
    dashboardTitle?: string;
    panelTitle?: string;
    panelId?: number;
    mathExpression?: string;
    evalIntervalSeconds?: number;
    pendingFor?: string;
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
    if (request.contactPoint?.trim()) {
        try {
            const points = await grafanaGet<ContactPointRow[]>('/api/v1/provisioning/contact-points');
            const matched = matchContactPointName(points, request.contactPoint);
            if (!matched) {
                const names = points
                    .map((p) => p.name)
                    .filter((n): n is string => Boolean(n))
                    .slice(0, 12);
                return guidanceBase(
                    `Contact point **${request.contactPoint}** was not found. ` +
                        (names.length
                            ? `Available: ${names.map((n) => `\`${n}\``).join(', ')}.`
                            : 'No contact points are configured in this org.')
                );
            }
            contactPointName = matched;
        } catch (err) {
            return guidanceBase(
                `Could not list contact points (need Alerting permissions): ${extractErrorMessage(err)}`
            );
        }
    }

    const ruleTitle = defaultAlertRuleTitle(hit.title);
    const ruleGroup = defaultAlertRuleGroup(dashboardUid, hit.panelId);
    const evalIntervalSeconds = parseEvalIntervalSeconds(request.every);

    try {
        const existing = await grafanaGet<ProvisionedRuleRow[]>('/api/v1/provisioning/alert-rules');
        const prior = existing.find(
            (r) =>
                (r.title ?? '') === ruleTitle &&
                (r.folderUID ?? '') === resolvedFolder &&
                (r.ruleGroup ?? '') === ruleGroup
        );
        if (prior?.uid) {
            return {
                ok: true,
                alreadyExists: true,
                ruleUid: prior.uid,
                ruleTitle,
                ruleGroup,
                folderUID: resolvedFolder,
                contactPoint: contactPointName,
                dashboardUid,
                dashboardTitle,
                panelTitle: hit.title,
                panelId: hit.panelId,
                mathExpression: built.mathExpression,
                evalIntervalSeconds,
                pendingFor: request.pendingFor ?? '1m',
            };
        }
    } catch {
        // Listing may fail without full read ACL — still try create.
    }

    const orgId = Number(config.bootData?.user?.orgId ?? 1);
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
    });

    let created: ProvisionedRuleRow;
    try {
        created = await grafanaPost<ProvisionedRuleRow>('/api/v1/provisioning/alert-rules', body);
    } catch (err) {
        return guidanceBase(`Alert rule create failed: ${extractErrorMessage(err)}`);
    }

    // Ensure the new rule group evaluates at the requested interval (default new groups are often 60s).
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
        // Interval update is best-effort; rule create already succeeded.
    }

    return {
        ok: true,
        ruleUid: created.uid,
        ruleTitle,
        ruleGroup,
        folderUID: resolvedFolder,
        contactPoint: contactPointName,
        dashboardUid,
        dashboardTitle,
        panelTitle: hit.title,
        panelId: hit.panelId,
        mathExpression: built.mathExpression,
        evalIntervalSeconds,
        pendingFor: request.pendingFor ?? '1m',
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

    const existsNote = result.alreadyExists
        ? `\n\nThis rule already existed — no duplicate was created.`
        : '';

    return (
        `### Grafana alert created (build ${buildNumber})\n\n` +
        (result.alreadyExists ? `**Already present** — ` : `**Saved** — `) +
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
            ? `- **Contact point:** **${result.contactPoint}**\n`
            : `- **Contact point:** _(not set — routed by default notification policy)_\n`) +
        `- **Rule group:** \`${result.ruleGroup}\` · folder \`${result.folderUID}\`\n` +
        existsNote +
        `\n\nOpen **Alerts & IRM → Alert rules** to preview/edit. ` +
        `Hard-refresh the dashboard to see the panel’s linked alert badge.`
    );
}
