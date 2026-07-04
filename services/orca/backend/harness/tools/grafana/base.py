"""Base class for all native Grafana tools.

All native Grafana tools inherit from ``GrafanaBaseTool`` which handles:
- HTTP client construction with the session credential (Phase 0 auth chain)
- 401 detection → ``ReauthRequiredError`` (surfaces as ``reauth_required`` SSE)
- 403 detection → ``PermissionDenied`` ToolResult (never raises)
- Connection/timeout errors → ``ToolError(code="datasource_error", retryable=True)``

Tools call ``self._query(ctx, url, method, body)`` for all Grafana API calls.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import structlog

from harness.tools.protocol import ToolContext, ToolError, ToolResult

logger = structlog.get_logger()


class GrafanaBaseTool:
    """Mixin providing a Grafana HTTP client for native tool implementations.

    Subclasses must set ``name``, ``description``, ``input_schema``, and
    ``cost_class`` as class attributes and implement ``async run()``.
    """

    async def _query(
        self,
        ctx: ToolContext,
        url: str,
        method: str = "GET",
        body: dict[str, Any] | None = None,
        grafana_url: str | None = None,
    ) -> tuple[int, dict[str, Any]]:
        """Execute an HTTP request against the Grafana API.

        Uses the credential from ``ctx`` for the Authorization header.
        Injects ``X-Grafana-Org-Id`` when ``ctx.credential.org_id`` is set.

        Args:
            ctx: Tool context carrying the Grafana credential.
            url: Path relative to the Grafana base URL (e.g. ``/api/datasources``).
            method: HTTP method (``GET`` or ``POST``).
            body: Optional request body (sent as JSON for POST).
            grafana_url: Override the Grafana base URL (defaults to settings.GRAFANA_URL).

        Returns:
            Tuple of (status_code, response_json).
        """
        from app.config import settings

        base = (grafana_url or settings.GRAFANA_URL).rstrip("/")
        full_url = f"{base}{url}"
        token = ctx.credential.token
        org_id = ctx.credential.org_id

        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }
        if org_id is not None:
            headers["X-Grafana-Org-Id"] = str(org_id)

        timeout = ctx.tool_timeout_s

        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                if method.upper() == "POST":
                    resp = await client.post(full_url, headers=headers, json=body)
                else:
                    resp = await client.get(full_url, headers=headers)

            return resp.status_code, _safe_json(resp)

        except httpx.TimeoutException:
            logger.warning("grafana_tool_timeout", tool=getattr(self, "name", "?"), url=full_url)
            raise
        except Exception as exc:
            logger.error("grafana_tool_http_error", tool=getattr(self, "name", "?"), error=str(exc))
            raise

    def _permission_denied(self, datasource_uid: str = "") -> ToolResult:
        """Build a PermissionDenied ToolResult (403 from Grafana).

        Args:
            datasource_uid: Datasource that denied the query.

        Returns:
            ToolResult with error.code == "permission_denied".
        """
        return ToolResult(
            data=None,
            error=ToolError(
                code="permission_denied",
                message=(
                    f"Access denied to datasource {datasource_uid!r}. "
                    "The acting identity does not have query permission."
                ),
                retryable=False,
            ),
        )

    def _datasource_error(self, message: str, retryable: bool = True) -> ToolResult:
        """Build a datasource error ToolResult.

        Args:
            message: Human-readable error description.
            retryable: Whether the error is likely transient.

        Returns:
            ToolResult with error.code == "datasource_error".
        """
        return ToolResult(
            data=None,
            error=ToolError(
                code="datasource_error",
                message=message,
                retryable=retryable,
            ),
        )


def _safe_json(resp: httpx.Response) -> dict[str, Any]:
    """Parse response JSON or return a fallback dict.

    Args:
        resp: httpx Response.

    Returns:
        Parsed JSON dict or ``{"_raw": resp.text}``.
    """
    try:
        return resp.json()
    except Exception:
        return {"_raw": resp.text[:2000]}
