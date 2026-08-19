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
    reconcilePendingWithEvalInterval,
} from './grafanaAlertBuild';
import { findPanelByTitleRelaxed, listDashboardPanels } from './panelDiscovery';

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
    folderTitle?: string;
    folderCreated?: boolean;
    contactPoint?: string;
    contactPointCreated?: boolean;
    labels?: Record<string, string>;
    restrictMetadata?: boolean;
    summary?: string;
    description?: string;
    customAnnotations?: Record<string, string>;
    dashboardUid?: string;
    dashboardTitle?: string;
    panelTitle?: string;
    panelId?: number;
    mathExpression?: string;
    evalIntervalSeconds?: number;
    pendingFor?: string;
    /** True when pending was raised so it is ≥ evaluation interval. */
    pendingAdjusted?: boolean;
    requestedPendingFor?: string;
    /** True when Flux was rewritten to `_time`/`_value` (no output `_field` labels). */
    alertCompatibleQueries?: boolean;
    /** Hybrid follow-up that built the rule from a named panel (not metadata-only update). */
    buildFromPanel?: boolean;
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

interface SearchHit {
    uid?: string;
    title?: string;
    type?: string;
}

const MIN_UID_PREFIX_LEN = 8;

async function loadDashboardByUidOrPrefix(
    requestedUid: string
): Promise<{ dashResp: DashboardApiResponse; resolvedUid: string } | { error: string }> {
    try {
        const dashResp = await grafanaGet<DashboardApiResponse>(
            `/api/dashboards/uid/${encodeURIComponent(requestedUid)}`
        );
        if (dashResp?.dashboard) {
            return { dashResp, resolvedUid: requestedUid };
        }
    } catch (err) {
        // Fall through to prefix search — operators often paste a truncated UID.
        const prefixErr = extractErrorMessage(err);
        if (requestedUid.length < MIN_UID_PREFIX_LEN) {
            return { error: `Could not load dashboard \`${requestedUid}\`: ${prefixErr}` };
        }
        try {
            const hits = await grafanaGet<SearchHit[]>('/api/search?type=dash-db&limit=5000');
            const matches = (Array.isArray(hits) ? hits : []).filter((h) => {
                const uid = (h.uid ?? '').trim();
                return uid === requestedUid || uid.startsWith(requestedUid);
            });
            if (matches.length === 1 && matches[0].uid) {
                const resolvedUid = matches[0].uid;
                const dashResp = await grafanaGet<DashboardApiResponse>(
                    `/api/dashboards/uid/${encodeURIComponent(resolvedUid)}`
                );
                if (!dashResp?.dashboard) {
                    return {
                        error: `Dashboard \`${resolvedUid}\` (matched from \`${requestedUid}\`) returned no dashboard JSON.`,
                    };
                }
                return { dashResp, resolvedUid };
            }
            if (matches.length > 1) {
                const listed = matches
                    .slice(0, 8)
                    .map((h) => `\`${h.uid}\` (${h.title ?? 'untitled'})`)
                    .join(', ');
                return {
                    error:
                        `Dashboard UID \`${requestedUid}\` is incomplete and matches ${matches.length} dashboards: ${listed}. ` +
                        `Use the full UID from the Grafana URL (the part after \`/d/\`).`,
                };
            }
            return {
                error:
                    `Could not load dashboard \`${requestedUid}\`: ${prefixErr}. ` +
                    `If this UID was copied short, paste the full UID from the dashboard URL.`,
            };
        } catch (searchErr) {
            return {
                error: `Could not load dashboard \`${requestedUid}\`: ${prefixErr} (search: ${extractErrorMessage(searchErr)})`,
            };
        }
    }
    return { error: `Dashboard \`${requestedUid}\` returned no dashboard JSON.` };
}

function similarPanelHint(entries: ReturnType<typeof listDashboardPanels>, want: string): string {
    const needle = want.toLowerCase();
    const similar = entries
        .filter((e) => {
            const t = e.title.toLowerCase();
            return (
                t.includes('randomforest') ||
                t.includes('random forest') ||
                t.includes('peer rf') ||
                (needle.length >= 12 && t.includes(needle.slice(0, 24)))
            );
        })
        .slice(0, 8)
        .map((e) => `“${e.title}”`);
    if (similar.length === 0) {
        return '';
    }
    return ` Nearby titles: ${similar.join('; ')}.`;
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

async function resolveOrCreateFolderByTitle(
    title: string
): Promise<{ uid: string; title: string; created: boolean } | { error: string }> {
    const want = title.trim();
    if (!want) {
        return { error: 'Folder title is empty.' };
    }
    try {
        const folders = await grafanaGet<Array<{ uid?: string; title?: string }>>('/api/folders');
        const existing = folders.find((f) => (f.title ?? '').trim().toLowerCase() === want.toLowerCase());
        if (existing?.uid?.trim()) {
            return { uid: existing.uid.trim(), title: existing.title ?? want, created: false };
        }
    } catch (err) {
        return { error: `Could not list folders: ${extractErrorMessage(err)}` };
    }
    try {
        const created = await grafanaPost<{ uid?: string; title?: string }>('/api/folders', {
            title: want,
        });
        const uid = created.uid?.trim();
        if (!uid) {
            return { error: `Created folder **${want}** but Grafana returned no UID.` };
        }
        return { uid, title: created.title ?? want, created: true };
    } catch (err) {
        return { error: `Could not create folder **${want}**: ${extractErrorMessage(err)}` };
    }
}

async function verifyRuleSaved(
    savedUid: string | undefined,
    ruleTitle: string,
    folderUID: string
): Promise<ProvisionedRuleRow | undefined> {
    if (savedUid) {
        try {
            const rule = await grafanaGet<ProvisionedRuleRow>(
                `/api/v1/provisioning/alert-rules/${encodeURIComponent(savedUid)}`
            );
            if (rule?.uid) {
                return rule;
            }
        } catch {
            // Fall through to a list-based lookup below.
        }
    }
    try {
        const all = await grafanaGet<ProvisionedRuleRow[]>('/api/v1/provisioning/alert-rules');
        return all.find(
            (r) => (r.title ?? '') === ruleTitle && (r.folderUID ?? '') === folderUID
        );
    } catch {
        return undefined;
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
    // Same title in the target folder (evaluation group may have changed).
    const byTitleFolder = existing.find(
        (r) => (r.title ?? '') === opts.ruleTitle && (r.folderUID ?? '') === opts.folderUID
    );
    if (byTitleFolder) {
        return byTitleFolder;
    }
    // Panel-linked rule, but ONLY within the target folder — never reach across folders
    // and mangle an unrelated rule for the same panel (that produced "updated" on a rule
    // the operator never asked about, so the intended rule was never created here).
    return existing.find(
        (r) =>
            (r.folderUID ?? '') === opts.folderUID &&
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

    const dashboardUidRequested = request.dashboardUid?.trim();
    if (!dashboardUidRequested) {
        return guidanceBase('Missing dashboard UID. Include `dashboard with UID = …` in the prompt.');
    }
    if (!request.panelTitle?.trim()) {
        return guidanceBase('Missing panel title. Include `panel titled "…"` in the prompt.');
    }

    const loaded = await loadDashboardByUidOrPrefix(dashboardUidRequested);
    if ('error' in loaded) {
        return guidanceBase(loaded.error);
    }
    const dashResp = loaded.dashResp;
    const dashboardUid = loaded.resolvedUid;

    const dashboard = dashResp.dashboard;
    if (!dashboard) {
        return guidanceBase(`Dashboard \`${dashboardUid}\` returned no dashboard JSON.`);
    }

    const dashboardTitle =
        typeof dashboard.title === 'string' ? dashboard.title : undefined;
    const folderUID = (dashResp.meta?.folderUid ?? '').trim();
    let resolvedFolder = folderUID;
    let resolvedFolderTitle: string | undefined = dashResp.meta?.folderTitle;
    let folderCreated = false;

    if (request.folderTitle?.trim()) {
        const folderResult = await resolveOrCreateFolderByTitle(request.folderTitle.trim());
        if ('error' in folderResult) {
            return guidanceBase(folderResult.error);
        }
        resolvedFolder = folderResult.uid;
        resolvedFolderTitle = folderResult.title;
        folderCreated = folderResult.created;
    } else if (!resolvedFolder) {
        // General folder is empty string in some versions; provisioning wants a real folder UID.
        try {
            const folders = await grafanaGet<Array<{ uid?: string; title?: string }>>('/api/folders');
            const preferred =
                folders.find((f) => /keysight|alerting|alerts/i.test(f.title ?? '')) ?? folders[0];
            resolvedFolder = preferred?.uid?.trim() ?? '';
            resolvedFolderTitle = preferred?.title;
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
    const hit = findPanelByTitleRelaxed(entries, request.panelTitle);
    if (!hit) {
        const uidNote =
            dashboardUid !== dashboardUidRequested
                ? ` (resolved \`${dashboardUidRequested}\` → \`${dashboardUid}\`)`
                : '';
        return guidanceBase(
            `Panel titled **${request.panelTitle}** was not found on dashboard \`${dashboardUid}\`${uidNote}.` +
                similarPanelHint(entries, request.panelTitle)
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

    const ruleTitle = (request.ruleTitle?.trim() || defaultAlertRuleTitle(hit.title)).slice(0, 190);
    const ruleGroup = (
        request.ruleGroup?.trim() || defaultAlertRuleGroup(dashboardUid, hit.panelId)
    ).slice(0, 190);
    const evalIntervalSeconds = parseEvalIntervalSeconds(request.every);
    const pendingReconcile = reconcilePendingWithEvalInterval(
        request.pendingFor,
        evalIntervalSeconds
    );
    const requestForBody: GrafanaAlertCreateRequest = {
        ...request,
        pendingFor: pendingReconcile.pendingFor,
    };
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
        request: requestForBody,
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

    // Post-save verification: confirm the rule is actually readable in the target folder.
    // Grafana can return 2xx yet leave no usable rule (e.g. rejected metadata, group churn),
    // which previously surfaced as a false "created/updated" reply.
    const savedUid = saved.uid ?? priorUid;
    const verified = await verifyRuleSaved(savedUid, ruleTitle, resolvedFolder);
    if (!verified?.uid) {
        return guidanceBase(
            `Grafana accepted the ${updated ? 'update' : 'create'} request but the rule ` +
                `**${ruleTitle}** could not be verified in folder ` +
                `**${resolvedFolderTitle ?? resolvedFolder}**` +
                (savedUid ? ` (expected uid \`${savedUid}\`)` : '') +
                `. It may have been rejected or removed during group setup — check ` +
                `**Alerts & IRM → Alert rules**.`
        );
    }

    return {
        ok: true,
        updated,
        alreadyExists: updated,
        ruleUid: verified.uid ?? savedUid,
        ruleTitle,
        ruleGroup,
        folderUID: resolvedFolder,
        folderTitle: resolvedFolderTitle,
        folderCreated,
        contactPoint: contactPointName,
        contactPointCreated,
        labels: request.labels,
        restrictMetadata: request.restrictMetadata,
        summary: request.summary,
        description: request.description,
        customAnnotations: request.customAnnotations,
        dashboardUid,
        dashboardTitle,
        panelTitle: hit.title,
        panelId: hit.panelId,
        mathExpression: built.mathExpression,
        evalIntervalSeconds,
        pendingFor: pendingReconcile.pendingFor,
        pendingAdjusted: pendingReconcile.adjusted,
        requestedPendingFor: pendingReconcile.requestedPendingFor,
        alertCompatibleQueries: true,
        buildFromPanel: request.buildFromPanel,
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

    const headline = result.buildFromPanel
        ? `### Grafana alert created (build ${buildNumber})\n\n**Saved from panel** — `
        : result.updated
          ? `### Grafana alert updated (build ${buildNumber})\n\n**Updated** — `
          : `### Grafana alert created (build ${buildNumber})\n\n**Saved** — `;

    const labelLine =
        result.labels && Object.keys(result.labels).length > 0
            ? `- **Labels:** ${Object.entries(result.labels)
                  .map(([k, v]) => `\`${k}=${v}\``)
                  .join(', ')}${result.restrictMetadata ? ' _(only requested labels — no graft defaults)_' : ''}\n`
            : result.restrictMetadata
              ? `- **Labels:** _(none — only requested labels)_\n`
              : '';
    const summaryLine = result.summary ? `- **Summary:** ${result.summary}\n` : '';
    const descriptionLine = result.description ? `- **Description:** ${result.description}\n` : '';
    const customAnnLine =
        result.customAnnotations && Object.keys(result.customAnnotations).length > 0
            ? `- **Custom annotations:** ${Object.entries(result.customAnnotations)
                  .map(([k, v]) => `\`${k}\` = ${v}`)
                  .join('; ')}\n`
            : '';
    const folderDisplay = result.folderTitle
        ? `**${result.folderTitle}**` +
          (result.folderUID ? ` (\`${result.folderUID}\`)` : '') +
          (result.folderCreated ? ' _(newly created)_' : '')
        : `\`${result.folderUID}\``;

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
        `- **Evaluate:** every **${result.evalIntervalSeconds ?? 60}s** · pending **${result.pendingFor ?? '1m'}**` +
        (result.pendingAdjusted
            ? ` _(raised from ${result.requestedPendingFor ?? '1m'} so pending ≥ evaluation interval)_`
            : '') +
        `\n` +
        (result.contactPoint
            ? `- **Contact point:** **${result.contactPoint}**${result.contactPointCreated ? ' _(newly created email contact point)_' : ''}\n`
            : `- **Contact point:** _(not set — routed by default notification policy)_\n`) +
        `- **Rule group:** \`${result.ruleGroup}\` · folder ${folderDisplay}\n` +
        labelLine +
        summaryLine +
        descriptionLine +
        customAnnLine +
        (result.alertCompatibleQueries
            ? `- **Alert queries:** rewritten to numeric \`_time\`/\`_value\` series (24h lookback for ±2σ hourly bands)\n`
            : '') +
        `\nOpen **Alerts & IRM → Alert rules** → Preview. Confirm Math \`H\` is \`1\` when Actual is outside the band, then wait ≥ pending period for email.`
    );
}
