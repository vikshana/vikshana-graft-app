---
name: verify-ui
description: Use when verifying that a frontend code change, LLM harness edit, or system prompt update produces the expected result in the running Graft plugin UI (http://localhost:3000/a/vikshana-graft-app). Drives a real headed Chrome session via Chrome DevTools MCP — navigate, click, inspect console errors, inspect network requests, take screenshots to output/, assert structure and behaviour, iterate until correct, then hand off to the developer. Use ONLY for this repo's Graft Grafana plugin.
---

# Skill: Verify UI (Graft Plugin)

Use this skill to verify that a code change produces the expected result in the running Graft plugin UI before handing off to the developer for manual checks.

Uses the **Chrome DevTools MCP** (`chrome-devtools` tools) to drive a real, headed, isolated Chrome session against the local Grafana instance.

---

## Prerequisites

Before running verification, check the following using the Bash tool:

1. **`dist/module.js` exists** — run `ls dist/module.js` to confirm. If missing, run `npm run build` first.
2. **Grafana is reachable** — run `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/health`. If not 200, tell the developer to run `npm run server` and wait ~15s.
3. **Google Chrome is installed** — run `ls "/Applications/Google Chrome.app"` on macOS. Required by Chrome DevTools MCP.

Do not use the shell scripts directly from this skill — invoke them as Bash tool calls instead if needed:
- Precheck: use the Bash tool with command `sh scripts/verify-ui-precheck.sh`
- Reload wait: use the Bash tool with command `sh scripts/wait-for-plugin-reload.sh`

---

## The Verification Loop

### Step 1 — Confirm the built bundle is current

After a code change, confirm the plugin's `module.js` was rebuilt before navigating the browser. Use the Bash tool:

```
ls -la dist/module.js
```

If running in watch mode (`npm run dev`), wait for webpack to finish its current compilation before proceeding. Check the webpack output in the terminal.

If a fresh build is needed, use the Bash tool to run `npm run build` and wait for it to complete.

### Step 2 — Check the LLM plugin health gate (chat verification only)

Before running any chat scenario, check whether the Grafana LLM plugin is configured. Use the `evaluate_script` Chrome DevTools MCP tool after navigating to Grafana:

```js
const r = await fetch('/api/plugins/grafana-llm-app/health');
const d = await r.json();
const ok = d?.details?.llmProvider?.ok === true &&
           d?.details?.llmProvider?.models?.base?.ok === true;
console.log('LLM ready:', ok, JSON.stringify(d?.details?.llmProvider));
return ok;
```

**If `ok` is false:** Stop. Tell the developer:
> "The Grafana LLM plugin is not configured. Please open http://localhost:3000, go to Administration → Plugins → Grafana LLM App → Configuration, add a provider API key, and click Save & Test. Let me know when done and I will continue."

Wait for confirmation before proceeding with chat verification.

**For non-chat pages** (history, prompts, config page) — skip this gate entirely.

### Step 3 — Navigate and dismiss the Grafana portal backdrop

Use the `navigate_page` Chrome DevTools MCP tool to open the plugin:

```
navigate_page: http://localhost:3000/a/vikshana-graft-app
```

Grafana 13 Enterprise renders a trial/licence modal in `#grafana-portal-container` on startup that intercepts all pointer events — clicks will silently fail if it is present. Dismiss it immediately:

1. Use `take_snapshot` to inspect the DOM.
2. If any of these are visible, `click` the first one found:
   - `button[aria-label="Close dialogue"]`
   - `button[aria-label="Close"]`
   - `button` containing text "Maybe later"
   - `button` containing text "Skip"
   - `button` containing text "Close"
3. Use `evaluate_script` to confirm the backdrop is gone:
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
4. If still blocked, wait 1 second and retry the dismissal.

### Step 4 — Run the scenario

Drive the browser through the user flow for the specific change being verified. Use the test ID inventory below to locate elements.

Always `take_snapshot` before clicking something new — it gives you the current DOM state rather than guessing at selectors.

General interaction pattern using Chrome DevTools MCP tools:
- `take_snapshot` — inspect DOM, find elements by `data-testid`
- `click` — interact with elements (use CSS selector or visible text)
- `fill` or `type_text` — enter text into inputs
- `wait_for` — wait for an expected element or text to appear
- `take_screenshot` — capture evidence; save to `output/<scenario>-<step>.jpeg`
- `press_key` — keyboard interactions (e.g. Enter to submit)

### Step 5 — Inspect console and network (mandatory after every scenario)

Always run these two checks after any scenario — they are the primary diagnostic tools:

**Console — use `list_console_messages`:**
- `[ERROR]` entries explain blank panels and missing renders
- `[WARN]` from Grafana's plugin loader indicate the plugin failed to load
- React render errors from the `ErrorBoundary` component

**Network — use `list_network_requests`:**

For chat flows, check for these requests:
- `/api/plugins/grafana-llm-app/settings` — must be 200, `enabled: true`
- `/api/plugins/grafana-llm-app/health` — must be 200, `llmProvider.ok: true`
- `/api/plugins/grafana-llm-app/openai/v1/chat/completions` — must be 200, non-empty response

If the chat/completions call is missing entirely, the frontend did not reach it — look for an earlier error in the console log.

### Step 6 — Assert structure and behaviour

Do **not** assert exact LLM response text — model output is non-deterministic. Assert structure:

| What to verify | How |
|---|---|
| Chat response rendered | `wait_for` + `take_snapshot` — assistant message bubble present |
| Tool call executed | Snapshot shows `[data-testid="tool-call-container"]` or tool-result block |
| Plan block rendered | Snapshot shows `[data-testid="plan-block-header"]` |
| Thinking block rendered | Snapshot shows a thinking/reasoning block element |
| No JS errors | `list_console_messages` — zero `[ERROR]` entries |
| LLM call returned 200 | `list_network_requests` — chat/completions shows status 200 |
| Response non-empty | Snapshot — at least one assistant message bubble with non-empty text |

For non-chat pages, assert concrete DOM state:
- Correct heading visible in snapshot
- Expected components present by `data-testid`
- No error boundary fallback rendered

### Step 7 — Iterate on mismatch

If the assertion fails:

1. **Console errors first** — a JS error almost always explains a blank render. Fix the source, rebuild (Bash tool: `npm run build`), go back to Step 1.
2. **Network next** — if the LLM call returned non-200 or was never made, the issue is in `src/services/llm.ts` or the health check logic. Fix, rebuild, loop.
3. **LLM harness/prompt issues** — if the response renders but structure is wrong (no tool calls, no plan block):
   - Inspect the raw `chat/completions` response body from `list_network_requests`
   - Adjust the system prompt or tool definitions in `src/services/llm.ts`
   - Rebuild and re-verify — multiple iterations are expected for harness changes
4. Take a screenshot at each iteration to `output/<scenario>-attempt-N.jpeg` for a visual trail.

### Step 8 — Hand off

Only hand off when:
- The scenario completed without JS errors (`list_console_messages` clean)
- The expected UI structure is present in the snapshot
- For chat: `chat/completions` returned 200 and a response is rendered
- At least one screenshot exists in `output/`

Present this summary to the developer:

```
## Verification complete — ready for manual review

**Scenario:** <what was tested>
**Screenshots:** output/<list of files>
**Console:** Clean — no errors
**Network:** LLM health ✓, chat/completions ✓ (200)
**Asserted:** <what structure/behaviour was confirmed>

**Please manually confirm:**
- <thing 1 requiring human judgement — e.g. visual styling looks right>
- <thing 2 — e.g. response text is on-topic and helpful>
```

---

## Data-testid Inventory

Real `data-testid` values from the codebase (inline in component JSX — `src/components/testIds.ts` is stale scaffold, do not use it):

| Page / Component | `data-testid` value |
|---|---|
| Chat — landing heading | `landing-title` |
| Chat — message input | `chat-input` |
| Chat — send button | `send-message-button` |
| Chat — standard mode | `mode-button-standard` |
| Chat — deep research mode | `mode-button-deep-research` |
| Chat — history nav link | `previous-conversations-link` |
| Chat — settings link | `settings-button` |
| Chat — prompt library link | `prompt-library-link` |
| Chat — plan block header | `plan-block-header` |
| Chat — plan step group | `step-group-header-step_1` |
| History — search input | `history-search-input` |
| History — session card | `session-card` |
| History — back button | `back-button` |
| Agent config — OSS header | `tier-header-oss` |
| Agent config — Loki category | `tool-category-loki` |
| Agent config — max iterations | `max-tool-iterations-input` |

To find additional IDs: use the Bash tool with `grep -r 'data-testid' src/`.

---

## Known Pitfalls

1. **Stale bundle** — the most common cause of "I tested it but it looks different". Always confirm `dist/module.js` mtime changed after a rebuild before navigating.

2. **Grafana portal backdrop** — Grafana 13 Enterprise renders a full-viewport modal on first load. If clicks appear to do nothing, this backdrop is the cause. See Step 3 dismissal sequence.

3. **Anonymous auth** — local Grafana uses anonymous Admin auth; no login needed. If a login page appears, the container started with `ANONYMOUS_AUTH_ENABLED=false`. Restart with `npm run server`.

4. **Plugin not loaded** — if `/a/vikshana-graft-app` shows "Plugin not found", check with Bash tool: `docker logs vikshana-graft-app | tail -20`.

5. **LLM plugin install lag** — on first container start, `GF_PLUGINS_PREINSTALL` downloads `grafana-llm-app`. The health endpoint may 404 for ~30s. Wait and retry.

6. **Isolated Chrome profile** — `--isolated` means clean LocalStorage each session. Seed history-dependent flows via `evaluate_script`:
   ```js
   localStorage.setItem('graft_chat_history', JSON.stringify([/* session objects */]));
   ```

7. **`evaluate_script` scope** — scripts run in the active page's context. Always `navigate_page` first, then `evaluate_script`.

---

## Route Reference

| URL | Content |
|---|---|
| `http://localhost:3000/a/vikshana-graft-app` | Chat interface |
| `http://localhost:3000/a/vikshana-graft-app/history` | Chat history |
| `http://localhost:3000/a/vikshana-graft-app/prompts` | Prompt library |
| `http://localhost:3000/plugins/vikshana-graft-app` | Plugin config (AppConfig) |
| `http://localhost:3000/api/plugins/grafana-llm-app/health` | LLM health (JSON) |
| `http://localhost:3000/api/plugins/grafana-llm-app/settings` | LLM settings (JSON) |

---

## Output

Screenshots land in `output/` (gitignored). Use descriptive names:

```
output/chat-landing.jpeg
output/chat-response-rendered.jpeg
output/chat-tool-call-block.jpeg
output/history-page.jpeg
output/prompt-library.jpeg
```
