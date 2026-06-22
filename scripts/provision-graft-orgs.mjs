#!/usr/bin/env node
/*
 * Provision Graft + the Grafana LLM app across every organization.
 *
 * Enabling an app plugin and configuring the LLM model mapping is per-organization
 * in Grafana, which is tedious to click through for each org. This script does it
 * in one pass from a Grafana *server admin* account:
 *
 *   1. GET  /api/orgs                    list every org
 *   2. POST /api/orgs/:id/users          add the admin to the org (if needed)
 *   3. POST /api/user/using/:id          switch the admin's active org
 *   4. POST /api/plugins/<graft>/settings        enable + pin Graft
 *   5. POST /api/plugins/grafana-llm-app/settings set provider + model mapping
 *
 * It is idempotent (safe to re-run), preserves existing plugin jsonData and the
 * stored Anthropic key (unless you pass a new one), and restores the admin's
 * original active org when finished.
 *
 * AUTH (server admin required — service-account tokens cannot list/switch orgs):
 *   GRAFANA_ADMIN_USER + GRAFANA_ADMIN_PASSWORD   (HTTP basic auth)
 *
 * USAGE:
 *   GRAFANA_ADMIN_USER=admin GRAFANA_ADMIN_PASSWORD=*** \
 *   node scripts/provision-graft-orgs.mjs [options]
 *
 * OPTIONS:
 *   --url <url>            Grafana base URL (default: $GRAFANA_URL or https://35.175.68.13)
 *   --base-model <id>      base/default model    (default: claude-sonnet-4-6)
 *   --large-model <id>     "large" model         (default: claude-sonnet-4-6)
 *   --provider <name>      LLM provider          (default: anthropic)
 *   --anthropic-key <key>  set/replace the Anthropic key (default: $ANTHROPIC_API_KEY, else keep existing)
 *   --orgs <ids>           only these org ids, comma-separated (default: all)
 *   --graft-plugin <id>    Graft plugin id       (default: vikshana-graft-app)
 *   --only-enable          only enable Graft, skip LLM config
 *   --only-llm             only configure the LLM app, skip enabling Graft
 *   --no-membership        do not add the admin to orgs (assumes already a member)
 *   --insecure             accept self-signed TLS (default: on for https IP hosts)
 *   --secure               force TLS verification on
 *   --dry-run              print what would change without writing
 *
 * EXAMPLES:
 *   # All orgs, base->sonnet, keep existing keys:
 *   GRAFANA_ADMIN_USER=admin GRAFANA_ADMIN_PASSWORD=*** node scripts/provision-graft-orgs.mjs
 *
 *   # Just org 10 and 12, dry run:
 *   ... node scripts/provision-graft-orgs.mjs --orgs 10,12 --dry-run
 */

const args = process.argv.slice(2);
function flag(name) {
  return args.includes(`--${name}`);
}
function opt(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

const GRAFT_PLUGIN = opt('graft-plugin', 'vikshana-graft-app');
const LLM_PLUGIN = 'grafana-llm-app';
const URL_BASE = (opt('url', process.env.GRAFANA_URL || 'https://35.175.68.13')).replace(/\/+$/, '');
const BASE_MODEL = opt('base-model', 'claude-sonnet-4-6');
const LARGE_MODEL = opt('large-model', 'claude-sonnet-4-6');
const PROVIDER = opt('provider', 'anthropic');
const ANTHROPIC_KEY = opt('anthropic-key', process.env.ANTHROPIC_API_KEY || '');
const ORG_FILTER = opt('orgs', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);
const DRY_RUN = flag('dry-run');
const ONLY_ENABLE = flag('only-enable');
const ONLY_LLM = flag('only-llm');
const DO_MEMBERSHIP = !flag('no-membership');

const USER = process.env.GRAFANA_ADMIN_USER;
const PASS = process.env.GRAFANA_ADMIN_PASSWORD;

// Self-signed certs are the norm for the EC2 IP host; default to insecure unless --secure.
const INSECURE = flag('secure') ? false : flag('insecure') || /^https:\/\/\d+\.\d+\.\d+\.\d+/.test(URL_BASE);
if (INSECURE) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

function die(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

if (!USER || !PASS) {
  die('Set GRAFANA_ADMIN_USER and GRAFANA_ADMIN_PASSWORD (server admin) in the environment.');
}

const authHeader = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

async function api(method, path, body) {
  const res = await fetch(`${URL_BASE}${path}`, {
    method,
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, ok: res.ok, body: json };
}

async function getPluginSettings(pluginId) {
  const r = await api('GET', `/api/plugins/${pluginId}/settings`);
  if (!r.ok) {
    return null;
  }
  return r.body;
}

async function enableGraft(org) {
  const current = await getPluginSettings(GRAFT_PLUGIN);
  if (!current) {
    return { action: 'skip', detail: `${GRAFT_PLUGIN} not installed/visible` };
  }
  if (current.enabled) {
    return { action: 'ok', detail: 'already enabled' };
  }
  if (DRY_RUN) {
    return { action: 'would-enable', detail: '' };
  }
  // Preserve any existing jsonData; just flip enabled/pinned on.
  const r = await api('POST', `/api/plugins/${GRAFT_PLUGIN}/settings`, {
    enabled: true,
    pinned: true,
    jsonData: current.jsonData || {},
  });
  return r.ok
    ? { action: 'enabled', detail: '' }
    : { action: 'error', detail: `${r.status} ${JSON.stringify(r.body)}` };
}

async function configureLlm(org) {
  const current = await getPluginSettings(LLM_PLUGIN);
  if (!current) {
    return { action: 'skip', detail: `${LLM_PLUGIN} not installed/visible` };
  }
  const existing = current.jsonData || {};
  const desired = {
    ...existing,
    disabled: false,
    provider: PROVIDER,
    models: {
      default: existing?.models?.default || 'base',
      mapping: {
        ...(existing?.models?.mapping || {}),
        base: BASE_MODEL,
        large: LARGE_MODEL,
      },
    },
    openAI: existing.openAI || { disabled: false },
  };

  const mappingMatches =
    existing?.models?.mapping?.base === BASE_MODEL &&
    existing?.models?.mapping?.large === LARGE_MODEL &&
    existing?.provider === PROVIDER;
  const keyAlreadySet = !!current.secureJsonFields?.anthropicKey;

  if (mappingMatches && (keyAlreadySet || !ANTHROPIC_KEY)) {
    return { action: 'ok', detail: `base=${BASE_MODEL}` };
  }
  if (DRY_RUN) {
    return {
      action: 'would-config',
      detail: `base=${BASE_MODEL}${ANTHROPIC_KEY ? ' +key' : ''}`,
    };
  }

  const payload = { enabled: true, pinned: true, jsonData: desired };
  // Only send the key when explicitly provided; otherwise Grafana keeps the stored one.
  if (ANTHROPIC_KEY) {
    payload.secureJsonData = { anthropicKey: ANTHROPIC_KEY };
  }
  const r = await api('POST', `/api/plugins/${LLM_PLUGIN}/settings`, payload);
  return r.ok
    ? { action: 'configured', detail: `base=${BASE_MODEL}${ANTHROPIC_KEY ? ' +key' : ''}` }
    : { action: 'error', detail: `${r.status} ${JSON.stringify(r.body)}` };
}

async function ensureMembership(org, adminLogin) {
  if (!DO_MEMBERSHIP) {
    return { action: 'skip', detail: 'membership skipped' };
  }
  if (DRY_RUN) {
    return { action: 'would-join', detail: '' };
  }
  const r = await api('POST', `/api/orgs/${org.id}/users`, {
    loginOrEmail: adminLogin,
    role: 'Admin',
  });
  if (r.ok) {
    return { action: 'joined', detail: '' };
  }
  const msg = JSON.stringify(r.body || '');
  if (r.status === 409 || /already.*member|already.*added/i.test(msg)) {
    return { action: 'ok', detail: 'already member' };
  }
  return { action: 'error', detail: `${r.status} ${msg}` };
}

async function switchOrg(orgId) {
  if (DRY_RUN) {
    return true;
  }
  const r = await api('POST', `/api/user/using/${orgId}`);
  return r.ok;
}

async function main() {
  console.log(`\nGraft org provisioning`);
  console.log(`  Grafana:   ${URL_BASE}${INSECURE ? ' (TLS verification off)' : ''}`);
  console.log(`  Admin:     ${USER}`);
  console.log(`  Graft:     ${GRAFT_PLUGIN}  | LLM: ${LLM_PLUGIN}`);
  console.log(`  Models:    base=${BASE_MODEL}, large=${LARGE_MODEL}, provider=${PROVIDER}`);
  console.log(`  Key:       ${ANTHROPIC_KEY ? 'will set/replace' : 'preserve existing'}`);
  console.log(`  Mode:      ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}\n`);

  const me = await api('GET', '/api/user');
  if (!me.ok) {
    die(`auth failed for ${USER} (${me.status}). Need a Grafana server admin.`);
  }
  const adminLogin = me.body.login;
  const originalOrgId = me.body.orgId;
  if (!me.body.isGrafanaAdmin) {
    console.warn(`WARNING: ${adminLogin} is not a Grafana server admin — listing/switching orgs may fail.\n`);
  }

  const orgsRes = await api('GET', '/api/orgs');
  if (!orgsRes.ok) {
    die(`could not list orgs (${orgsRes.status}). A server admin account is required.`);
  }
  let orgs = orgsRes.body;
  if (ORG_FILTER.length) {
    orgs = orgs.filter((o) => ORG_FILTER.includes(o.id));
  }
  if (!orgs.length) {
    die('no matching orgs.');
  }

  const rows = [];
  for (const org of orgs) {
    const row = { id: org.id, name: org.name, membership: '-', graft: '-', llm: '-' };

    const mem = await ensureMembership(org, adminLogin);
    row.membership = `${mem.action}${mem.detail ? ` (${mem.detail})` : ''}`;
    if (mem.action === 'error') {
      rows.push(row);
      continue;
    }

    const switched = await switchOrg(org.id);
    if (!switched) {
      row.graft = row.llm = 'switch-failed';
      rows.push(row);
      continue;
    }

    if (!ONLY_LLM) {
      const g = await enableGraft(org);
      row.graft = `${g.action}${g.detail ? ` (${g.detail})` : ''}`;
    }
    if (!ONLY_ENABLE) {
      const l = await configureLlm(org);
      row.llm = `${l.action}${l.detail ? ` (${l.detail})` : ''}`;
    }
    rows.push(row);
    console.log(`  org ${String(org.id).padEnd(4)} ${String(org.name).padEnd(22)} graft=${row.graft} | llm=${row.llm}`);
  }

  // Restore the admin's original active org.
  if (!DRY_RUN && originalOrgId != null) {
    await switchOrg(originalOrgId);
  }

  const errors = rows.filter((r) => /error|failed/.test(`${r.membership}${r.graft}${r.llm}`));
  console.log(`\nDone. ${rows.length} org(s) processed, ${errors.length} error(s).`);
  if (errors.length) {
    for (const e of errors) {
      console.log(`  ! org ${e.id} (${e.name}): membership=${e.membership} graft=${e.graft} llm=${e.llm}`);
    }
    process.exit(2);
  }
}

main().catch((e) => die(e?.stack || String(e)));
