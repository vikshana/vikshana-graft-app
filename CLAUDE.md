# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Graft is a Grafana app plugin that provides an AI assistant interface. It consists of:
- **Frontend**: React/TypeScript application using Grafana UI components
- **Backend**: Go plugin using Grafana Plugin SDK for settings and health checks

LLM orchestration is handled by the Grafana LLM plugin (`grafana-llm-app`), not this plugin's backend.

The plugin ID is `vikshana-graft-app`.

## Build Commands

### Frontend
```bash
npm install          # Install dependencies
npm run dev          # Build in watch mode
npm run build        # Production build
npm run typecheck    # TypeScript check without emit
npm run lint         # ESLint
npm run lint:fix     # ESLint + Prettier fix
```

### Backend
```bash
mage -v              # Build binaries for all platforms
mage build:linuxARM64  # Build for ARM64 (required for Apple Silicon + Docker)
```

### Running
```bash
npm run server       # Start Grafana in Docker with the plugin
```

For ARM64 development (Apple Silicon):
```bash
rm ./dist/gpx_* && mage -v build:linuxARM64 && docker compose up --build --force-recreate --remove-orphans
```

## Testing

### Unit Tests (Jest)
```bash
npm run test         # Watch mode
npm run test:ci      # CI mode (exits after running)
```

Run a single test file:
```bash
npx jest src/services/chatHistory.test.ts
```

### E2E Tests (Playwright)
```bash
npm run server       # Start Grafana first
npm run e2e          # Run Playwright tests
```

Test files are in `tests`. Fixtures are in `tests/fixtures.ts`.

### Backend Tests (Go)
```bash
go test ./pkg/...
```

## Architecture

### Frontend (`src/`)

**Entry Point**: `module.tsx` exports the Grafana `AppPlugin` with MCP client wrapper.

**Main Components**:
- `components/features/App/App.tsx` - Main router with routes for `/` (chat), `/history`, `/prompts`
- `components/features/ChatInterface/ChatInterface.tsx` - Primary chat UI with dual-model support (Standard/Deep Research)
- `components/features/AppConfig/AppConfig.tsx` - Plugin configuration page
- `pages/ChatHistory.tsx` - Chat history browser
- `pages/PromptLibrary.tsx` - Prompt template management

**Services** (`src/services/`):
- `llm.ts` - LLM communication via `@grafana/llm`, handles tool execution agent loop (max 5 iterations)
- `chatHistory.ts` - LocalStorage-based session persistence
- `promptLibrary.ts` - Prompt template management
- `context.ts` - Grafana context (user, dashboard, datasources)

**Types** (`src/types/`):
- `llm.types.ts` - Message, Attachment, ToolExecution interfaces
- `chat.types.ts` - ChatSession interface
- `prompt.types.ts` - Prompt library types
- `context.types.ts` - Grafana context types
- `common.types.ts` - Shared common types

### Backend (`pkg/`)

**Plugin Entry**: `pkg/main.go` initializes the app via Grafana SDK.

**Core Components**:
- `pkg/plugin/app.go` - Plugin instance, route registration (`/settings`, `/ping`), health checks, metrics setup
- `pkg/plugin/otel.go` - OpenTelemetry tracer and meter provider setup

The backend does not handle LLM calls directly - this is delegated to the Grafana LLM plugin.

### Model Configuration

Model configuration (Standard and Deep Research) is managed through the Grafana LLM plugin (`grafana-llm-app`), not this plugin. The frontend uses:
- `llm.Model.BASE` - Standard/fast responses
- `llm.Model.LARGE` - Deep Research/complex reasoning

This plugin only stores prompt library configuration.

### MCP Integration

The frontend uses `@grafana/llm` MCP client for tool execution. Tools are loaded from MCP servers and converted to OpenAI format. The agent loop in `src/services/llm.ts` handles tool calls with max 5 iterations.

## Key Patterns

- **Styling**: Emotion CSS-in-JS via `@emotion/css` and `useStyles2` hook
- **State**: React hooks with URL-based session management via `react-router-dom`
- **LLM Calls**: Frontend calls `@grafana/llm` directly (synchronous chat completions, not streaming)
- **Test IDs**: `data-testid` attributes are defined inline in JSX. `src/components/testIds.ts` is stale scaffold — do not use it. Find real IDs via `grep -r 'data-testid' src/`.
- **Lazy Loading**: Route components use React lazy loading with Suspense

## Workflow Rules

### Branching
- Before starting any change, check the current branch with `git branch --show-current`.
- If on `main`, create a feature branch (`git checkout -b feature/<short-description>`) before making any commits.
- All commits must go to the feature branch — never commit directly to `main`.

### Commit messages
All commit messages **must** follow the [Conventional Commits](https://www.conventionalcommits.org) format:

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

**Always include a scope** where it reflects the area of the codebase being changed. Use the scope to describe *what part* of the repo is affected, not *what was done* (that's the type).

Scopes for this repo:

| Scope | When to use |
|---|---|
| `chat` | Chat interface, message handling, conversation flow |
| `llm` | LLM service, model selection, tool execution loop |
| `history` | Chat history storage and browsing |
| `prompts` | Prompt library management |
| `config` | Plugin configuration page (AppConfig) |
| `context` | Grafana context service (user, dashboard, datasources) |
| `mcp` | MCP client integration and tool handling |
| `backend` | Go plugin backend (health checks, routes, metrics) |
| `deps` | Dependency updates (npm, Go modules) |
| `ci` | CI/CD workflow files |
| `release` | Release configuration and process |

Commit types and their effect on versioning:

| Type | When to use | Version bump |
|---|---|---|
| `feat` | New user-facing feature | Minor (`0.2.0 → 0.3.0`) |
| `fix` | Bug fix | Patch (`0.2.0 → 0.2.1`) |
| `feat!` / `BREAKING CHANGE:` footer | Incompatible API change | Major (`0.2.0 → 1.0.0`) |
| `perf` | Performance improvement | Patch |
| `docs` | Documentation only | No bump (visible in changelog) |
| `chore` | Maintenance, dependency updates | No bump |
| `refactor` | Code restructure, no behaviour change | No bump |
| `test` | Adding or fixing tests | No bump |
| `ci` | CI/CD pipeline changes | No bump |
| `build` | Build system changes | No bump |

Examples:
```
feat(chat): add file attachment support
fix(llm): handle empty response from health check
refactor(context): simplify dashboard context fetching
test(history): add session pagination tests
docs(release): update release workflow guide
chore(deps): bump grafana/ui to v11
ci(release): upgrade release-please-action to v5
feat!(config): redesign prompt library API
```

> Commit messages drive the automated release process — release-please reads them to determine the next version and generate the CHANGELOG. Vague messages like `fix: stuff`, missing types, or missing scopes will produce unhelpful changelogs.

### Testing
- After every change, run the full test suite before committing:
  1. Unit + integration tests: `npm run test:ci`
  2. Backend tests: `go test ./pkg/...`
  3. E2E tests: `npm run e2e` (requires Grafana running via `npm run server`)
- All tests must pass. Fix any regressions before proceeding.

### Pull Requests
- Push the feature branch and open a PR against `main` using `gh pr create`.
- After creating the PR, check for Copilot (or other automated) review comments:
  ```bash
  gh pr view <number> --comments
  gh api repos/{owner}/{repo}/pulls/<number>/comments
  ```
- Review each comment, implement fixes for relevant ones, then push the updated branch.

### Definition of Done
- The task is only complete and ready for human review when:
  1. All unit, backend, and E2E tests pass.
  2. The PR's CI pipeline passes (check with `gh pr checks <number>`).
  3. All relevant automated review comments have been addressed.

### CI path filters
The CI workflows (`ci.yml`, `is-compatible.yml`, `bundle-stats.yml`) only run when files that can affect their outcome are changed — `src/**`, `pkg/**`, `tests/**`, build config, etc. PRs that touch only docs, `CLAUDE.md`, workflow files, or release config will skip the real CI jobs and instead run a lightweight companion workflow (e.g. `ci-skip.yml`) that reports success immediately so branch protection checks stay green.

**This is intentional and safe.** Files outside the path filters cannot affect the built artifact or test outcomes. If you add a new build config file (e.g. a new root-level `eslint.config.js`), add it to the `paths` list in `ci.yml` and the `paths-ignore` list in `ci-skip.yml` to keep the two in sync.

The following files/directories are intentionally outside CI path filters (docs/tooling only):
- `opencode.json`, `.opencode/**` — OpenCode agent configuration and skills
- `scripts/**` — developer helper scripts
- `docs/**`, `CLAUDE.md`, `README.md` — documentation
- `output/**` — verification screenshots (gitignored content)
### Versioning and Releases
- Releases are managed automatically by **release-please**. Do not manually edit `package.json` version, `CHANGELOG.md`, or push version tags.
- Commit messages must follow **Conventional Commits** (see above) — release-please reads them to determine the next version and generate the CHANGELOG.
- After merging to `main`, release-please opens a Release PR automatically. Merge it when ready to publish a release.
- See `docs/release_workflow.md` for the full release process.

## UI Verification Workflow

After making frontend changes, **always verify the result in the actual running plugin UI before handing off to the developer for manual review**. This closes the gap between "I assume it works" and "the actual UI is completely different".

### How to trigger

Load the `verify-ui` skill before starting a browser-driven verification pass:

```
Load skill: verify-ui
```

The skill encodes the full verification loop: rebuild gate → plugin reload gate → LLM health gate → drive headed Chrome → inspect console + network → screenshot → assert → iterate → hand off.

### Quick reference

```sh
# 1. Ensure Grafana is running with the latest build
npm run build && npm run server   # or: npm run dev (watch) + npm run server

# 2. Run the precheck
sh scripts/verify-ui-precheck.sh

# 3. After a rebuild, wait for Grafana to serve the new bundle
sh scripts/wait-for-plugin-reload.sh

# 4. Load the verify-ui skill in OpenCode and run the verification loop
```

### What gets verified

- **Non-chat pages**: Correct rendering, navigation, DOM structure (history, prompts, config).
- **Chat flows**: LLM health gate → send message → confirm tool call / plan / thinking blocks render → no JS console errors → LLM network calls return 200 → non-empty response rendered.
- **LLM harness iteration**: When structure is wrong (no tool calls, no plan block), the agent inspects the raw `chat/completions` response and iterates on system prompts / `src/services/llm.ts` until the structure is correct.

### Screenshots

Screenshots land in `output/` (gitignored). The agent shows you the list of screenshots and an explicit "please manually confirm X" list at hand-off.

### Tools used

- **Chrome DevTools MCP** (`opencode.json`) — drives a headed, isolated Chrome session.
- `navigate_page`, `take_snapshot`, `take_screenshot`, `click`, `fill`, `type_text`, `wait_for` — browser automation.
- `list_console_messages` — diagnose JS errors (most common cause of blank panels).
- `list_network_requests` — confirm LLM API calls fired and returned 200.
- `evaluate_script` — read `localStorage`, poll plugin health, dismiss Grafana portal backdrop.

See `docs/ui_verification_workflow.md` for the full contributor guide.
