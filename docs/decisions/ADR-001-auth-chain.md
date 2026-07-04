# ADR-001: Auth Chain Design

**Date:** 2026-07-04
**Status:** Accepted
**Deciders:** Implementation team

## Context

The agent harness needs to call Grafana datasource APIs (`/api/ds/query`) on behalf of users. Grafana OSS has no service-account impersonation. Three viable paths exist:

1. **Entra OBO** — exchange the user's Entra ID token for a Grafana-scoped token via On-Behalf-Of flow
2. **Session passthrough** — forward the user's active Grafana session for interactive turns
3. **Service account** — use per-team Grafana service account tokens (non-attributed)

## Decision

Implement all three paths. Activate them via priority-ordered chain:
- OBO is preferred but gated behind `AUTH_ENTRA_OBO_ENABLED=false` (feature flag)
- Session passthrough is second
- Service account is always available as last resort

Rationale: Entra OBO requires a real Entra tenant and is complex to validate in dev. Feature-flagging allows the full code path to be implemented and tested against mock-oauth2-server in development, while production operators enable it when the tenant is configured.

## Consequences

- Every auth-sourced token is tagged with `auth_mode` and propagated to audit logs
- Refresh tokens are encrypted at rest (Fernet) in `user_tokens` table
- The service account path is always available, so the system never fails to function when OBO is misconfigured — it degrades gracefully
- Sessions initiated with `auth_mode=service_account` must be visually tagged in the UI ("running with team credentials")
- OBO requires `OIDC_ISSUER`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`, `OBO_ENCRYPTION_KEY` to be set when enabled
