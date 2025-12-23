# Release Workflow

This document explains how releases are created and published for the Graft plugin.

## Automated Release Process

The plugin uses GitHub Actions to automate the release process. When a version tag is pushed, the workflow:

1. Builds the frontend (React/TypeScript)
2. Builds the backend (Go) for multiple platforms
3. Packages the plugin as a zip archive
4. Creates a GitHub Release with the artifact attached

## Creating a Release

To create a new release:

1. Update the version in `package.json`
2. Update `CHANGELOG.md` with release notes
3. Commit the changes:
   ```bash
   git add package.json CHANGELOG.md
   git commit -m "chore: bump version to x.y.z"
   ```
4. Create and push a version tag:
   ```bash
   git tag vX.Y.Z
   git push origin main
   git push origin vX.Y.Z
   ```

The workflow triggers on tags matching `v*` (e.g., `v1.0.0`, `v1.2.3`).

## Version and Date Substitution

The `grafana/plugin-actions/build-plugin` action automatically replaces placeholders in `src/plugin.json` during the build:

| Placeholder | Replaced With |
|-------------|---------------|
| `%VERSION%` | Version from the git tag (e.g., `v1.2.3` → `1.2.3`) |
| `%TODAY%`   | Current date in `YYYY-MM-DD` format |

**Note:** The source `plugin.json` keeps the placeholders—substitution only happens in the built release artifact.

## Changelog

The `CHANGELOG.md` is **not auto-generated**. You must manually update it before creating a release (see step 2 in "Creating a Release" above).

## Release Artifacts

The release will be available at:
```
https://github.com/vikshana/vikshana-graft-app/releases
```

Each release includes a zip archive (`vikshana-graft-app-x.y.z.zip`) containing the built plugin ready for installation.

## Plugin Signing

The plugin is currently **unsigned**. The release workflow has plugin signing commented out.

### Running Unsigned Plugins

Users installing unsigned plugins must configure Grafana to allow them:

```ini
# grafana.ini or custom.ini
[plugins]
allow_loading_unsigned_plugins = vikshana-graft-app
```

Or via environment variable:
```bash
GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=vikshana-graft-app
```

### Enabling Plugin Signing

To sign releases (recommended for production distribution):

1. Register the plugin with Grafana at [grafana.com/developers](https://grafana.com/developers/)
2. Generate an access policy token ([instructions](https://grafana.com/developers/plugin-tools/publish-a-plugin/sign-a-plugin#generate-an-access-policy-token))
3. Add the token as a repository secret named `GRAFANA_ACCESS_POLICY_TOKEN`
4. Update `.github/workflows/release.yml` to enable signing:
   ```yaml
   - uses: grafana/plugin-actions/build-plugin@build-plugin/v1.0.2
     with:
       policy_token: ${{ secrets.GRAFANA_ACCESS_POLICY_TOKEN }}
   ```

## Workflow File

The release workflow is defined in `.github/workflows/release.yml`.
