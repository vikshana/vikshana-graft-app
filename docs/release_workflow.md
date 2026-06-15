# Release Workflow

This document explains how releases are created and published for the Graft plugin. The process is automated using [release-please](https://github.com/googleapis/release-please), which derives version bumps and changelogs directly from commit messages.

---

## How it works

Graft uses **Conventional Commits** and **release-please** to automate the release lifecycle:

1. Developers merge feature/fix PRs to `main` using Conventional Commit messages.
2. After each merge, release-please opens (or updates) a **Release PR** automatically. This PR contains the version bump to `package.json` and the auto-generated `CHANGELOG.md` entries.
3. When the team is ready to cut a release, they **merge the Release PR**.
4. Merging the Release PR causes release-please to push a `vX.Y.Z` tag, which triggers the `release.yml` workflow to build and publish the GitHub Release.

No manual version editing, no manual tagging, no manual changelog writing.

---

## Commit message conventions

Version bumps are determined automatically from commit message prefixes:

| Commit type | Example | Version bump |
|---|---|---|
| `fix:` | `fix: correct health check timeout` | Patch (`0.2.0 → 0.2.1`) |
| `feat:` | `feat: add dark mode support` | Minor (`0.2.0 → 0.3.0`) |
| `feat!:` or `BREAKING CHANGE:` footer | `feat!: redesign config API` | Major (`0.2.0 → 1.0.0`) |
| `chore:`, `test:`, `ci:`, `refactor:` | `chore: update dependencies` | No bump (hidden from changelog) |
| `docs:` | `docs: improve setup guide` | No bump (shown in changelog) |
| `perf:` | `perf: optimise bundle size` | Patch |

> **Note:** While the repo is pre-1.0 (`0.x.y`), `feat:` bumps the minor version and `fix:` bumps the patch, as configured by `bump-minor-pre-major` and `bump-patch-for-minor-pre-major` in `release-please-config.json`. A `BREAKING CHANGE` still bumps major.

---

## Step-by-step: releasing a new version

### 1. Merge feature/fix PRs normally

Work proceeds as usual — open PRs against `main`, get them reviewed, merge them. Ensure commit messages follow the Conventional Commits format above.

### 2. Wait for the Release PR

After each merge to `main`, the `release-please` GitHub Action runs and opens or updates a PR titled:

```
chore(main): release X.Y.Z
```

This PR accumulates all unreleased changes. You can let multiple PRs pile up before releasing — the Release PR updates itself each time.

### 3. Review the Release PR

Open the Release PR and check:
- The proposed version number is correct (patch/minor/major as expected)
- The `CHANGELOG.md` section looks complete and accurate
- All intended changes are included

If a commit message was wrong and the version bump is incorrect, you can override the version by adding a label to the Release PR:
- `autorelease: custom version` — then edit the PR body to set the desired version

### 4. Merge the Release PR

When ready to release, simply **merge the Release PR**. release-please will:
- Push a `vX.Y.Z` tag to `main`
- Create a GitHub Release

### 5. Automated build and publish

The `vX.Y.Z` tag push triggers `.github/workflows/release.yml`, which:
1. Builds the frontend (`npm run build`)
2. Builds the Go backend for all platforms (`mage -v`)
3. Packages `dist/` as `vikshana-graft-app-vX.Y.Z.zip`
4. Attaches the zip to the GitHub Release

The release is then available at:
```
https://github.com/vikshana/vikshana-graft-app/releases
```

---

## Configuration files

| File | Purpose |
|---|---|
| `.github/workflows/release-please.yml` | Runs release-please on every push to `main` |
| `release-please-config.json` | Configures release type, changelog sections, and version bump behaviour |
| `.release-please-manifest.json` | Tracks the last released version; updated automatically by release-please — do not edit manually |
| `.github/workflows/release.yml` | Builds and publishes the plugin artifact when a `v*` tag is pushed |

---

## Version and date substitution in plugin.json

`src/plugin.json` contains placeholder values that are substituted at build time:

| Placeholder | Replaced with |
|---|---|
| `%VERSION%` | The version from the git tag (e.g. `v0.3.0` → `0.3.0`) |
| `%TODAY%` | The current date in `YYYY-MM-DD` format |

The source file always keeps the placeholders — substitution only happens in the built artifact inside `dist/`.

---

## Hotfix releases

For urgent fixes that can't wait for the next scheduled release:

1. Create a branch from the release tag: `git checkout -b hotfix/0.2.1 v0.2.0`
2. Apply the fix with a `fix:` commit
3. Open a PR against `main` (and backport to the release branch if needed)
4. Once merged, the Release PR on `main` will propose the patch bump — merge it immediately

---

## Plugin signing

The plugin is currently **unsigned**. The signing step in `release.yml` is commented out. To enable signing after Grafana plugin approval:

1. Register the plugin at [grafana.com/developers](https://grafana.com/developers/)
2. Generate an access policy token ([instructions](https://grafana.com/developers/plugin-tools/publish-a-plugin/sign-a-plugin#generate-an-access-policy-token))
3. Add the token as repository secret `GRAFANA_ACCESS_POLICY_TOKEN`
4. Uncomment the signing step in `.github/workflows/release.yml`

Until then, users must allow unsigned plugins in their Grafana configuration:

```ini
# grafana.ini
[plugins]
allow_loading_unsigned_plugins = vikshana-graft-app
```

Or via environment variable:

```bash
GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=vikshana-graft-app
```
