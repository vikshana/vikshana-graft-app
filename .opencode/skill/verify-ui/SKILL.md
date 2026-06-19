# Skill: Verify UI (Graft Plugin)

Use this skill whenever you need to verify that a code change produces the expected result in the running Graft plugin UI, before handing off to the developer for manual checks.

This skill uses the **Chrome DevTools MCP** (`chrome-devtools` in `opencode.json`) to drive a real, headed, isolated Chrome session against the local Grafana instance.

---

## When to use

Load this skill when:
- You have made frontend code changes and need to confirm the UI renders as expected.
- You are iterating on the LLM harness (`src/services/llm.ts`) or system prompts and need to verify the chat flow behaves correctly against a live model.
- The developer has reported a UI difference from what you expected — use this to reproduce and diagnose it before making further changes.
- You are about to hand off to the developer for manual review — run a verification pass first so you can say "I have confirmed X in the browser; please spot-check Y."

---

## Prerequisites

Before running verification, confirm all of the following:

1. **Grafana is running** on `http://localhost:3000` via `npm run server` (docker compose).
2. **The plugin is built** — `dist/` exists and contains `module.js`. Run `npm run build` (one-shot) or ensure `npm run dev` (watch) has compiled the latest changes.
3. **Local Chrome** is installed (Google Chrome, not just Chromium). The Chrome DevTools MCP requires it. On macOS: `/Applications/Google Chrome.app`.
4. **The `chrome-devtools` MCP server** is configured in `opencode.json` (already done — `npx -y chrome-devtools-mcp@latest --isolated --screenshot-format=jpeg --no-usage-statistics`).

Run the precheck script and act on its output before proceeding:

```sh
sh scripts/verify-ui-precheck.sh
```

---

## The Verification Loop

### Step 1 — Wait for the plugin to reload after a rebuild

After making and building code changes, Grafana must serve the new `module.js` before the browser will reflect the change. Do **not** navigate the browser while a stale bundle is running.

```sh
sh scripts/wait-for-plugin-reload.sh
```

If the script is not available or you are in a live-editing session (`npm run dev` watch), use the `evaluate_script` tool to poll for the updated asset:

```js
// Run via evaluate_script on http://localhost:3000 — repeat until version changes
fetch('/api/plugins/vikshana-graft-app/settings')
  .then(r => r.json())
  .then(d => d.info?.version ?? 'unknown')
```

### Step 2 — Check the LLM plugin health gate

Before running any chat verification, confirm the Grafana LLM plugin is configured with a live provider. Use `evaluate_script` (on the Grafana page) or inspect the network:

```js
// evaluate_script on http://localhost:3000
const r = await fetch('/api/plugins/grafana-llm-app/health');
const d = await r.json();
const ok = d?.details?.llmProvider?.ok === true &&
           d?.details?.llmProvider?.models?.base?.ok === true;
console.log('LLM ready:', ok, JSON.stringify(d?.details?.llmProvider));
ok
```

**If the result is `false` or the endpoint 404s:**

> STOP. Do not proceed with chat verification. Tell the developer:
> "The Grafana LLM plugin is not configured. Please open http://localhost:3000, go to Administration → Plugins → Grafana LLM App → Configuration, and add a provider API key (e.g. OpenAI). Then click Save. Come back to me when the LLM health check passes."

After they configure it, re-run the health check before continuing.

**For non-chat pages** (history, prompts, config) you can skip this gate — the LLM is not involved.

### Step 3 — Navigate and dismiss the Grafana portal backdrop

Grafana 13 Enterprise renders a trial/licence modal inside `#grafana-portal-container` on startup. It intercepts pointer events and will cause all subsequent clicks to fail silently.

Always dismiss it immediately after navigating:

1. Navigate to the page under test:
   ```
   navigate_page → http://localhost:3000/a/vikshana-graft-app
   ```

2. Use `take_snapshot` to inspect the DOM. If a dismissible modal is present (look for `button[aria-label="Close dialogue"]`, `"Maybe later"`, `"Skip"`, or `"Close"`), click it:
   ```
   click → button[aria-label="Close dialogue"]
   ```
   Try each selector in order; skip if none are present.

3. Confirm the backdrop is gone using `evaluate_script`:
   ```js
   const portal = document.getElementById('grafana-portal-container');
   if (!portal) return true;
   const backdrops = Array.from(portal.querySelectorAll('[role="presentation"]'));
   const blocking = backdrops.find(el => {
     const r = el.getBoundingClientRect();
     return r.width > window.innerWidth * 0.9 && r.height > window.innerHeight * 0.9;
   });
   return !blocking;
   ```
   If this returns `false`, wait 1s and repeat the dismissal attempt.

### Step 4 — Run the scenario

Drive the browser through the specific user flow relevant to your change. Use the test ID inventory below to locate elements. Always `take_snapshot` before clicking something new — it gives you the actual DOM state to work from rather than guessing.

**General pattern:**
```
take_snapshot            → inspect DOM, find elements by data-testid
click / fill / type_text → interact
wait_for                 → wait for expected element or text to appear
take_screenshot          → capture evidence to output/<scenario>-<step>.jpeg
list_console_messages    → check for JS errors after each major interaction
```

### Step 5 — Inspect console and network (mandatory)

After running the scenario, always check:

```
list_console_messages
```

Look for:
- `[ERROR]` or uncaught exceptions — these explain blank panels and missing renders.
- `[WARN]` from Grafana's plugin loader about the plugin failing to load.
- React render errors from the ErrorBoundary.

```
list_network_requests
```

For chat flows, filter for requests to:
- `**/api/plugins/grafana-llm-app/settings` — must return 200 with `enabled: true`
- `**/api/plugins/grafana-llm-app/health` — must return 200 with `llmProvider.ok: true`
- `**/api/plugins/grafana-llm-app/openai/v1/chat/completions` — the actual LLM call; must return 200 and contain a non-empty `choices[0].message`

If the LLM call is missing from the network log, the frontend did not reach the call — look for an earlier error in the console.

### Step 6 — Assert structure and behaviour

**Do NOT assert exact LLM response text** — model output is non-deterministic. Assert structure instead:

| What to verify | How |
|---|---|
| Chat response rendered | `wait_for` + `take_snapshot` — check a message bubble element is present |
| Tool call executed | Snapshot shows a `[data-testid="tool-call-container"]` or tool-result block |
| Plan block rendered | Snapshot shows `[data-testid="plan-block-header"]` |
| Thinking block rendered | Snapshot shows a thinking/reasoning block element |
| No JS errors | `list_console_messages` — zero `[ERROR]` entries |
| LLM call returned 200 | `list_network_requests` — chat/completions request shows status 200 |
| Response non-empty | Snapshot — at least one assistant message bubble with non-empty text content |

For non-chat pages, assert concrete DOM state:
- Correct page title / heading visible in snapshot
- Expected components present by `data-testid`
- No error boundary fallback rendered

### Step 7 — Iterate on mismatch

If the assertion fails:

1. **Check console first** — a JS error usually explains a blank render. Fix the error in source, rebuild, go to Step 1.
2. **Check network** — if the LLM call returned non-200 or was never made, the issue is in `src/services/llm.ts` or the health check logic. Fix, rebuild, loop.
3. **For LLM harness/prompt issues** (response rendered but structure wrong — e.g. no tool calls, no plan block):
   - Examine the raw response from `list_network_requests` → chat/completions
   - Consider adjusting the system prompt in `src/services/llm.ts` or the tool definitions
   - Rebuild and re-verify — this loop may take several iterations; that is expected
4. **Take a screenshot** at each iteration to `output/<scenario>-attempt-N.jpeg` so you have a visual trail.

### Step 8 — Hand off

Only hand off to the developer when:
- The scenario runs without JS errors (`list_console_messages` clean)
- The expected UI structure is present in the snapshot
- For chat: the LLM network call returned 200 and a response is rendered
- Screenshots exist in `output/` as visual evidence

Present a hand-off summary:

```
## Verification complete — ready for manual review

**Scenario:** <what you tested>
**Screenshots:** output/<list of files>
**Console:** Clean — no errors
**Network:** LLM health ✓, chat/completions ✓ (200)
**Asserted:** <what structure/behaviour you confirmed>

**Please manually confirm:**
- <specific thing 1 that requires human judgement — e.g. visual styling looks correct>
- <specific thing 2 — e.g. the response text is on-topic and helpful>
```

---

## Data-testid Inventory

These are the real `data-testid` values used in the codebase (inline in JSX, not from `src/components/testIds.ts` which is stale scaffold).

| Page / Component | `data-testid` value | Notes |
|---|---|---|
| Chat — landing | `landing-title` | Main chat page heading |
| Chat — input | `chat-input` | Message textarea |
| Chat — send | `send-message-button` | Submit button |
| Chat — mode toggle | `mode-button-standard` | Standard model mode |
| Chat — mode toggle | `mode-button-deep-research` | Deep Research model mode |
| Chat — nav | `previous-conversations-link` | Link to history page |
| Chat — nav | `settings-button` | Settings/config link |
| Chat — nav | `prompt-library-link` | Prompt library link |
| Chat — plan block | `plan-block-header` | Rendered plan section header |
| Chat — step group | `step-group-header-step_1` | First step in a plan |
| History page | `history-search-input` | Search box |
| History page | `session-card` | Individual history session card |
| History page | `back-button` | Back navigation |
| Agent config | `tier-header-oss` | OSS tools section header |
| Agent config | `tool-category-loki` | Loki tool category |
| Agent config | `max-tool-iterations-input` | Max iterations input |

To find additional test IDs: `grep -r 'data-testid' src/` in the repo.

---

## Known Pitfalls

1. **Stale bundle**: The most common cause of "I tested it but it looks different". Always run `wait-for-plugin-reload.sh` or confirm the webpack hash has changed before navigating.

2. **Grafana portal backdrop**: Grafana 13 Enterprise renders a full-viewport modal on first load. If clicks do nothing, the backdrop is intercepting them. See Step 3 dismissal sequence.

3. **Anonymous auth**: Local Grafana uses anonymous Admin auth — no login needed. If you ever see a login page, the container may have started with `ANONYMOUS_AUTH_ENABLED=false` (CI mode). Restart with `npm run server` (which uses defaults).

4. **Plugin not loaded**: If `/a/vikshana-graft-app` shows "Plugin not found", `dist/` may be empty or the container has not mounted it. Check `docker ps` and `docker logs vikshana-graft-app`.

5. **`grafana-llm-app` auto-install lag**: On first container start, `GF_PLUGINS_PREINSTALL` downloads the LLM plugin. The health endpoint may return 404 for ~30s. Wait and retry.

6. **Isolated Chrome profile**: The `--isolated` flag means each MCP session starts with a clean Chrome profile. LocalStorage (`graft_chat_history`) is empty — seed it via `evaluate_script` if testing history-dependent flows:
   ```js
   localStorage.setItem('graft_chat_history', JSON.stringify([/* session objects */]));
   ```

7. **`evaluate_script` scope**: Scripts run in the context of the currently active page. Navigate first, then evaluate.

---

## Route Reference

| URL | Content |
|---|---|
| `http://localhost:3000/a/vikshana-graft-app` | Chat interface (default) |
| `http://localhost:3000/a/vikshana-graft-app/history` | Chat history browser |
| `http://localhost:3000/a/vikshana-graft-app/prompts` | Prompt library |
| `http://localhost:3000/plugins/vikshana-graft-app` | Plugin config page (AppConfig) |
| `http://localhost:3000/api/plugins/grafana-llm-app/health` | LLM plugin health (JSON) |
| `http://localhost:3000/api/plugins/grafana-llm-app/settings` | LLM plugin settings (JSON) |

---

## Output

Save all screenshots to `output/` with descriptive names:

```
output/chat-landing.jpeg
output/chat-response-rendered.jpeg
output/chat-tool-call-block.jpeg
output/history-page.jpeg
output/prompt-library.jpeg
```

The `output/` directory is gitignored. Screenshots are ephemeral evidence for the current verification session.
