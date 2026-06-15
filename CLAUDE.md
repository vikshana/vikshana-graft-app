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
- **Test IDs**: Use `data-testid` attributes defined in `src/components/testIds.ts`
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

### Versioning and Releases
- Releases are managed automatically by **release-please**. Do not manually edit `package.json` version, `CHANGELOG.md`, or push version tags.
- Commit messages must follow **Conventional Commits** (see above) — release-please reads them to determine the next version and generate the CHANGELOG.
- After merging to `main`, release-please opens a Release PR automatically. Merge it when ready to publish a release.
- See `docs/release_workflow.md` for the full release process.
