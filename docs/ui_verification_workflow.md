# UI Verification Workflow

This document explains how to use the agentic UI verification workflow to confirm code changes produce the expected result in the running Graft plugin before a human performs manual checks.

## The Problem It Solves

Previously, the agent would make frontend changes and assume they were working correctly. Manual UI checks often revealed the actual result was different — wrong layout, blank panel, missing component, LLM not responding — requiring back-and-forth with screenshots to diagnose. This workflow closes that loop: the agent verifies the change in a real browser first, confirms the structure and behaviour are correct, and only then hands off to the developer for a final visual sanity check.

## How It Works

The agent uses the **Chrome DevTools MCP server** (`chrome-devtools-mcp`) to drive a headed (visible), isolated Google Chrome session against the locally running Grafana instance. After every code change and rebuild, the agent:

1. Runs `scripts/verify-ui-precheck.sh` to confirm prerequisites.
2. Waits for the plugin to reload via `scripts/wait-for-plugin-reload.sh`.
3. Drives Chrome through the relevant user scenario.
4. Inspects the **browser console** (for JS errors) and **network requests** (for LLM API calls) to diagnose any issues.
5. Takes **screenshots** to `output/` as visual evidence.
6. Iterates — fixing code or refining the LLM harness — until the expected structure and behaviour are confirmed.
7. Hands off with a summary of what was confirmed and what you should manually verify.

## Prerequisites

### 1. Grafana running with the plugin

```sh
npm run build          # or: npm run dev (watch mode)
npm run server         # starts Grafana in Docker on http://localhost:3000
```

Wait ~15s for the container to start. The plugin is mounted from `dist/` into the container — changes rebuild automatically in watch mode.

### 2. Google Chrome installed

Chrome DevTools MCP requires **Google Chrome** (not just Chromium).

- macOS: Install from https://www.google.com/chrome/
- Verify: `/Applications/Google Chrome.app` exists.

### 3. grafana-llm-app configured (for chat verification only)

The Grafana LLM plugin is auto-installed when the container starts, but it needs a provider API key to respond. Configure it once per container:

1. Open http://localhost:3000
2. Go to **Administration → Plugins → Grafana LLM App → Configuration**
3. Add your provider API key (e.g. OpenAI)
4. Click **Save & Test** — confirm the health check goes green

This configuration is stored in the container. After `npm run server` restarts a container, you will need to reconfigure it — or use `docker compose up` (without `--build`) to reuse the existing container with its state.

For non-chat pages (history, prompts, config), the LLM is not needed.

### 4. Run the precheck

```sh
sh scripts/verify-ui-precheck.sh
```

Fix any `[FAIL]` items before starting a verification session. `[WARN]` items (LLM not configured) are non-blocking for non-chat scenarios.

## Configuration

The Chrome DevTools MCP server is configured in `opencode.json` at the repo root:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "chrome-devtools": {
      "type": "local",
      "command": ["npx", "-y", "chrome-devtools-mcp@latest",
                  "--isolated", "--screenshot-format=jpeg", "--no-usage-statistics"],
      "enabled": true
    }
  }
}
```

Key flags:
- `--isolated` — clean throwaway Chrome profile per session (reproducible, no state bleed between runs)
- `--screenshot-format=jpeg` — smaller screenshots, less context consumed in the agent conversation
- `--no-usage-statistics` — opts out of Google telemetry

**Headed by default** — no `--headless` flag, so you can watch the browser as the agent drives it.

To run headless (e.g. in a quiet background check):

```json
"command": ["npx", "-y", "chrome-devtools-mcp@latest", "--isolated", "--headless", "--screenshot-format=jpeg", "--no-usage-statistics"]
```

### OpenCode files

| File | Purpose |
|---|---|
| `opencode.json` | Chrome DevTools MCP server config |
| `.opencode/commands/verify-ui.md` | Slash command — invoked when you type `/verify-ui` or use Ctrl+P → Commands → `verify-ui` |
| `.opencode/skills/verify-ui/SKILL.md` | Skill — the full verification loop instructions loaded by the command |

## How to Invoke

Two equivalent entry points:

1. **Slash command** (recommended): type `/verify-ui` in the OpenCode TUI, or use **Ctrl+P → Commands → `verify-ui`**. Optionally pass a scenario:
   ```
   /verify-ui check the chat history page
   ```
2. **Natural language**: describe the task and the agent loads the skill automatically, e.g. *"verify the prompt library renders correctly"*.

The `/verify-ui` command is registered in `.opencode/commands/verify-ui.md`. It instructs the agent to load the `verify-ui` skill from `.opencode/skills/verify-ui/SKILL.md`, which contains the full step-by-step verification loop.

High level:

```
make code change
  → npm run build (or wait for dev watch to finish)
  → sh scripts/wait-for-plugin-reload.sh
  → [agent] navigate_page → http://localhost:3000/a/vikshana-graft-app
  → [agent] dismiss Grafana portal backdrop
  → [agent] run scenario (click, type, wait)
  → [agent] list_console_messages  ← diagnose errors here first
  → [agent] list_network_requests  ← confirm LLM calls fired and returned 200
  → [agent] take_screenshot → output/<scenario>.jpeg
  → assert structure / behaviour
  → if wrong: fix → rebuild → repeat
  → if right: hand off with summary + screenshot
```

## Reading Verification Output

### Screenshots (`output/`)

The `output/` directory is gitignored — screenshots are ephemeral session evidence. After a verification run the agent will tell you what each screenshot shows and what to confirm manually.

Naming convention used by the agent:
- `output/chat-landing.jpeg` — the chat page after load
- `output/chat-response-rendered.jpeg` — after a full chat round-trip
- `output/chat-tool-call-block.jpeg` — tool execution block in the chat
- `output/history-page.jpeg` — history browser
- `output/prompt-library.jpeg` — prompt library page

### Console output

The agent always runs `list_console_messages` after each scenario. Key things it looks for:

- `[ERROR]` entries — the most common cause of blank panels; the stack trace points directly at the broken code.
- React render errors — caught by the `ErrorBoundary` in `App.tsx`.
- Grafana plugin-loader warnings — indicate the plugin failed to load or mount.

### Network requests

For chat flows, the agent inspects:

| Endpoint | Expected |
|---|---|
| `/api/plugins/grafana-llm-app/settings` | HTTP 200, `enabled: true` |
| `/api/plugins/grafana-llm-app/health` | HTTP 200, `llmProvider.ok: true` |
| `/api/plugins/grafana-llm-app/openai/v1/chat/completions` | HTTP 200, non-empty `choices[0].message` |

If the chat/completions call is missing, the frontend did not reach it — look for an earlier error.

## What the Agent Asserts (and What It Doesn't)

The agent asserts **structure and behaviour**, not exact text:

| Asserted | Not asserted |
|---|---|
| Chat response bubble is rendered | Exact wording of the response |
| Tool call block appears | Which tool was chosen |
| Plan/thinking block appears | Content of the plan |
| No JS errors in console | Stylistic quality of the UI |
| LLM network calls return 200 | Response latency |

Exact text is non-deterministic from a live LLM. Visual quality (spacing, colour, typography) is for you to confirm in the hand-off step.

## Iterating on the LLM Harness

When a chat flow fails consistently (e.g. tool calls never fire, plan blocks never appear), the agent will:

1. Examine the raw chat/completions response from `list_network_requests`
2. Identify whether the model is responding without tool calls, or with incorrect structure
3. Adjust the system prompt or tool definitions in `src/services/llm.ts`
4. Rebuild and re-verify

This loop may take 2–5 iterations for complex harness changes. The agent will show you the intermediate screenshots and network responses so you can follow along.

## Troubleshooting

**The browser opens but the plugin page shows "Not Found"**
- Check `docker logs vikshana-graft-app` — the plugin may have failed to load.
- Ensure `dist/module.js` exists. Run `npm run build`.

**All clicks do nothing**
- The Grafana 13 Enterprise portal backdrop is intercepting events.
- The agent should dismiss it automatically; if it fails, try `navigate_page` to reload the page and retry.

**LLM health is green but chat produces no response**
- Check network: the chat/completions request may be returning a non-200 or empty response.
- Run the precheck again: `sh scripts/verify-ui-precheck.sh`.

**`wait-for-plugin-reload.sh` times out**
- The webpack build may still be running, or Grafana may not be detecting the file change.
- Try `docker compose restart grafana` (from the repo root) to force a plugin re-scan.

**Chrome DevTools MCP can't find Chrome**
- Ensure Google Chrome (not just Chromium) is installed.
- On macOS: `open -a "Google Chrome"` should launch it.

## CI Considerations

This workflow is **not part of the CI E2E suite** (`npm run e2e` / `tests/*.spec.ts`). It is an interactive, headed developer tool — not a headless automated gate. The CI E2E suite runs separately via `@grafana/plugin-e2e` and Playwright, against multiple Grafana versions, on GitHub Actions.

The `opencode.json`, `scripts/`, `.opencode/`, and `output/` files are excluded from CI path filters — they cannot affect the built plugin artifact, so CI correctly skips when only these files change.
