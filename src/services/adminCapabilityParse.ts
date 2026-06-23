/**
 * Detects Grafana administration requests that Graft cannot perform with its
 * MCP toolset (no user/org/team/permission/admin-API tools are exposed — see
 * toolFilter.ts). Instead of letting the LLM improvise a reply that loops on the
 * Continue nudge, we route these to a deterministic, accurate capability reply.
 */

import { extractDashboardUidFromMessage } from './dashboardMentionParse';

export type AdminRequestKind = 'create_organization' | 'manage_users' | 'manage_access';

export interface UnsupportedAdminRequest {
    kind: AdminRequestKind;
    mentionsDashboard: boolean;
}

function normalizeMessageQuotes(text: string): string {
    return text.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
}

const ORG_RE = /\borgani[sz]ations?\b/i;
const USER_RE = /\b(users?|accounts?|logins?|team\s*members?)\b/i;
const ROLE_RE = /\b(roles?|permissions?|teams?|access\s+control|rbac)\b/i;

const MUTATE_VERB =
    /\b(create|add|new|set\s*up|make|provision|register|invite|onboard|remove|delete|disable|deactivate|grant|give|assign|revoke|manage|change|update|configure|reset)\b/i;

/**
 * True for "give/add/grant a user access", "user that only has access to X org", etc.
 * Distinct from dashboard work because it targets users/accounts/logins, not panels.
 */
function describesUserManagement(text: string): boolean {
    if (!USER_RE.test(text)) {
        return false;
    }
    if (MUTATE_VERB.test(text)) {
        return true;
    }
    // "a user that only has access to ..." (access provisioning without an explicit verb)
    return /\buser\b[^.]*\baccess\b/i.test(text) || /\baccess\b[^.]*\buser\b/i.test(text);
}

function describesOrgManagement(text: string): boolean {
    return ORG_RE.test(text) && MUTATE_VERB.test(text);
}

function describesAccessManagement(text: string): boolean {
    return ROLE_RE.test(text) && MUTATE_VERB.test(text);
}

export function messageDescribesUnsupportedAdminRequest(
    message: string
): UnsupportedAdminRequest | null {
    const text = normalizeMessageQuotes(message.trim());
    if (!text) {
        return null;
    }

    const mentionsDashboardWord = /\bdash\s*board|dashboards?\b/i.test(text);

    // User management takes priority — "add a user to an org" is a user op, not an org op.
    if (describesUserManagement(text)) {
        return { kind: 'manage_users', mentionsDashboard: mentionsDashboardWord };
    }
    if (describesOrgManagement(text)) {
        return { kind: 'create_organization', mentionsDashboard: mentionsDashboardWord };
    }
    if (describesAccessManagement(text)) {
        return { kind: 'manage_access', mentionsDashboard: mentionsDashboardWord };
    }
    return null;
}

const ADMIN_REPLY_HEADING = '### Outside Graft’s access (Grafana admin task)';

/**
 * True when an assistant reply is declining / explaining a capability limit
 * (e.g. "I cannot create users", "requires admin access", "not part of Graft's toolset").
 * Such replies must NOT arm the Continue auto-loop or the pending-task machinery —
 * there is no dashboard save to finish.
 */
export function describesCapabilityLimitation(content: string): boolean {
    const text = content.trim();
    if (!text) {
        return false;
    }
    if (/Outside Graft[’']s access/i.test(text)) {
        return true;
    }
    const limitationPhrase =
        /\b(I\s*(?:can'?t|cannot|do\s*not|don'?t)\s+(?:create|add|invite|manage|provision|delete|remove))\b/i.test(
            text
        ) ||
        /\b(requires?\s+(?:admin|server[- ]admin|administrator)\s+access)\b/i.test(text) ||
        /\b(admin access (?:is )?(?:required|needed))\b/i.test(text) ||
        /\b(not part of|outside)\s+[^.\n]*\btoolset\b/i.test(text) ||
        /\b(don'?t|do not|doesn'?t)\s+have\s+(?:the\s+)?tools?\b/i.test(text) ||
        /\buser management (?:requires|uses)\b/i.test(text) ||
        /\bcannot create (?:organizations?|users?|orgs?)\b/i.test(text);
    return limitationPhrase;
}

function dashboardAlternative(message: string, mentionsDashboard: boolean): string {
    // Pure admin requests that never mention a dashboard (e.g. "add a user") get a
    // concise scope note instead of a clone pitch — leading with "clone a dashboard"
    // on a user/access question reads as a non-sequitur.
    if (!mentionsDashboard) {
        return (
            `**Once that exists in Grafana, Graft can take over the dashboards inside it** — ` +
            `build, edit, clone, and reorganize panels and folders (Prometheus, Loki, Influx).`
        );
    }
    const uid = extractDashboardUidFromMessage(message);
    const cloneExample = uid
        ? `Clone a system dashboard, e.g. \`Create a new dashboard for <new system> with the same data as the dashboard with UID = ${uid}.\``
        : `Clone a system dashboard, e.g. \`Create a new dashboard for a new system that has the same data as another system that already has a dashboard.\``;
    return (
        `**What Graft can do for you instead:**\n` +
        `- ${cloneExample}\n` +
        `- Build, edit, or reorganize dashboards and panels (Prometheus, Loki, Influx)\n` +
        `- Create folders to organize dashboards (\`create_folder\`)\n` +
        `\nIf you want, send the clone prompt above and Graft will copy the existing system dashboard now.`
    );
}

/**
 * Deterministic, accurate reply for admin requests Graft cannot execute.
 * Uses statements/imperatives only (no "would you like"/"should I") and a heading
 * that does NOT trigger the Continue auto-loop.
 */
export function formatUnsupportedAdminReply(
    request: UnsupportedAdminRequest,
    message: string
): string {
    if (request.kind === 'manage_users') {
        return (
            `${ADMIN_REPLY_HEADING}\n\n` +
            `Graft cannot create, invite, or manage Grafana **users** or their access. ` +
            `User management uses Grafana's admin API, which is not part of Graft's toolset.\n\n` +
            `**A Grafana Admin does this in the UI:**\n` +
            `1. **Administration → Users and access → Users**\n` +
            `2. **New user** (or **Invite**) — set name, email, login, password\n` +
            `3. For org-scoped access: open the user → **Organizations** → **Add organization** → pick the org (e.g. *Skywater-MN*) and role (Viewer / Editor / Admin)\n` +
            `4. Remove other orgs from that user if access should be limited to one\n\n` +
            dashboardAlternative(message, request.mentionsDashboard)
        );
    }

    if (request.kind === 'create_organization') {
        return (
            `${ADMIN_REPLY_HEADING}\n\n` +
            `Graft cannot create or manage Grafana **organizations** — that needs server-admin access through the admin API, which is not part of Graft's toolset.\n\n` +
            `**A Grafana server admin does this in the UI:**\n` +
            `1. **Administration → General → Organizations**\n` +
            `2. **New org** — name it\n` +
            `3. Re-add the datasources and folders that org needs (orgs do not share these)\n\n` +
            dashboardAlternative(message, request.mentionsDashboard)
        );
    }

    return (
        `${ADMIN_REPLY_HEADING}\n\n` +
        `Graft cannot manage Grafana **roles, permissions, or teams** — those use the admin/access-control API, which is not part of Graft's toolset.\n\n` +
        `**A Grafana Admin does this in the UI:**\n` +
        `1. **Administration → Users and access** (Users, Teams, or Service accounts)\n` +
        `2. Assign roles or team membership there\n` +
        `3. For dashboard-level sharing, use **folder permissions** on the relevant folder\n\n` +
        dashboardAlternative(message, request.mentionsDashboard)
    );
}
