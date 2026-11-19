# Renovate App Client ID migration

Renovate reuses the existing GitHub App and installation. Its token action now
uses the recommended `client-id` input instead of the deprecated `app-id` input.
No new App, key rotation, or installation change is required.

## Operator steps

1. Find the existing App's actual **Client ID** in its GitHub App settings. This
   differs from its numeric **App ID** and is not an OAuth **client secret**.
2. Use the existing organisation Actions secret `RENOVATE_APP_CLIENT_ID`,
   or configure a repository Actions secret with the same name. If using an
   organisation secret with selected-repository access, include
   `vikshana-graft-app` in that selection.
3. Keep the existing `RENOVATE_APP_PRIVATE_KEY` Actions secret and ensure this
   repository retains access to it. Do not change or delete the existing
   `RENOVATE_APP_ID` organisation secret: other repositories may still use it.
4. After merging and confirming secret access, manually dispatch **Renovate** and
   check that App authentication succeeds.

App and Client IDs are identifiers, not secrets; the private key remains a
secret. Do not substitute a numeric App ID or OAuth client secret for the Client
ID. Do not put credential values in source files, documentation, or logs.

The workflow retains its existing private-key authentication, owner and repository
scope, Action pins, schedule, and permissions. Release Please is unchanged and
continues to use its default `GITHUB_TOKEN`.

Actions secret access must be configured separately; this change does not
configure it or claim a successful authenticated Renovate execution.

See GitHub's [GitHub App JWT authentication documentation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app)
for the Client ID recommendation.
