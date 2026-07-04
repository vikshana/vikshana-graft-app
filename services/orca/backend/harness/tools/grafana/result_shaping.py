"""Result-shaping layer for native Grafana tool outputs.

Every native tool passes its raw Grafana API response through one of these
shapers before returning a ``ToolResult``.  Shaping ensures:

1. **Prompt size is bounded**: No tool result exceeds the configured caps.
2. **Drill-down is always available**: Truncated results store the full payload
   in ``drill_down_results`` with a 24h TTL and return a ``drill_down_handle``.
3. **Pattern summaries for logs**: Top-k line templates via prefix normalisation.
4. **Slowest path for traces**: Spans sorted by duration, tree summarised.

All shapers are pure functions except for the ``_store_drill_down`` helper
which writes to Postgres.  Tests can mock ``_store_drill_down`` to stay offline.
"""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import structlog

from harness.tools.protocol import ToolResult

logger = structlog.get_logger()

# Default caps (all configurable via settings)
DEFAULT_MAX_SERIES = 50
DEFAULT_MAX_POINTS_PER_SERIES = 200
DEFAULT_MAX_LOG_LINES_HEAD = 50
DEFAULT_MAX_LOG_LINES_TAIL = 50
DEFAULT_MAX_LOG_BYTES = 32 * 1024  # 32 KB
DEFAULT_MAX_SPANS = 500
DEFAULT_TOP_K_TEMPLATES = 10


@dataclass
class ShapedResult:
    """Intermediate result from a shaper before wrapping in ToolResult."""

    data: Any
    truncated: bool
    raw_bytes: int
    summary: str = ""


# ---------------------------------------------------------------------------
# Drill-down storage
# ---------------------------------------------------------------------------


async def _store_drill_down(
    session_id: str,
    tool_name: str,
    full_data: Any,
) -> str:
    """Store the full tool result for deferred drill-down access.

    Writes to the ``drill_down_results`` Postgres table with a 24h TTL.
    Returns a short opaque handle string.

    Args:
        session_id: Owning session identifier.
        tool_name: Name of the tool that produced the data.
        full_data: The complete, untruncated result payload.

    Returns:
        Opaque handle string (64 chars) for use with ``fetch_more``.
    """
    handle = hashlib.sha256(
        f"{session_id}:{tool_name}:{uuid.uuid4()}".encode()
    ).hexdigest()

    expires_at = datetime.now(timezone.utc) + timedelta(hours=24)

    try:
        from app.db import AsyncSessionLocal
        from sqlalchemy import text

        async with AsyncSessionLocal() as db:
            await db.execute(
                text("""
                    INSERT INTO drill_down_results
                        (handle, session_id, tool_name, full_result, created_at, expires_at)
                    VALUES
                        (:handle, :session_id, :tool_name, :full_result::jsonb, :now, :expires_at)
                    ON CONFLICT (handle) DO NOTHING
                """),
                {
                    "handle": handle,
                    "session_id": session_id,
                    "tool_name": tool_name,
                    "full_result": json.dumps(full_data, default=str),
                    "now": datetime.now(timezone.utc),
                    "expires_at": expires_at,
                },
            )
            await db.commit()
    except Exception as exc:
        logger.warning("drill_down_store_failed", tool=tool_name, error=str(exc))

    return handle


# ---------------------------------------------------------------------------
# LTTB downsampling helper
# ---------------------------------------------------------------------------


def _lttb_downsample(points: list[tuple[float, float]], threshold: int) -> list[tuple[float, float]]:
    """Largest Triangle Three Buckets downsampling.

    Reduces a time-series to ``threshold`` representative points while
    preserving the visual shape of the data.

    Args:
        points: List of (timestamp, value) tuples, sorted by timestamp.
        threshold: Target number of points.

    Returns:
        Downsampled list of (timestamp, value) tuples.
    """
    n = len(points)
    if n <= threshold:
        return points

    sampled = [points[0]]
    bucket_size = (n - 2) / (threshold - 2)

    for i in range(1, threshold - 1):
        avg_start = int((i - 1) * bucket_size) + 1
        avg_end = int(i * bucket_size) + 1
        avg_x = sum(p[0] for p in points[avg_start:avg_end]) / (avg_end - avg_start)
        avg_y = sum(p[1] for p in points[avg_start:avg_end]) / (avg_end - avg_start)

        range_start = int((i - 1) * bucket_size) + 1
        range_end = int((i + 1) * bucket_size) + 1
        prev = sampled[-1]

        max_area = -1.0
        best = points[range_start]
        for p in points[range_start:range_end]:
            area = abs(
                (prev[0] - avg_x) * (p[1] - prev[1])
                - (prev[0] - p[0]) * (avg_y - prev[1])
            ) * 0.5
            if area > max_area:
                max_area = area
                best = p
        sampled.append(best)

    sampled.append(points[-1])
    return sampled


# ---------------------------------------------------------------------------
# MetricsShaper
# ---------------------------------------------------------------------------


class MetricsShaper:
    """Shapes Prometheus/Mimir query results for prompt injection.

    Caps series count and downsamples each series to a bounded number of
    data points using the LTTB algorithm.
    """

    def __init__(
        self,
        max_series: int = DEFAULT_MAX_SERIES,
        max_points: int = DEFAULT_MAX_POINTS_PER_SERIES,
    ) -> None:
        self._max_series = max_series
        self._max_points = max_points

    def shape(self, grafana_response: dict[str, Any]) -> ShapedResult:
        """Shape a Grafana datasource query response for metrics.

        Args:
            grafana_response: Raw ``/api/ds/query`` JSON response.

        Returns:
            ShapedResult with the capped data and truncation metadata.
        """
        raw_bytes = len(json.dumps(grafana_response, default=str).encode())
        results = grafana_response.get("results", {})
        shaped_results: dict[str, Any] = {}
        truncated = False
        total_series = 0
        omitted_series = 0

        for ref_id, frame_data in results.items():
            frames = frame_data.get("frames", [])
            shaped_frames = []
            for frame in frames:
                schema = frame.get("schema", {})
                data = frame.get("data", {})
                values = data.get("values", [])

                if len(values) < 2:
                    shaped_frames.append(frame)
                    total_series += 1
                    continue

                # values[0] is timestamps, values[1:] are metric values
                timestamps = values[0]
                metric_cols = values[1:]

                if total_series + len(metric_cols) > self._max_series:
                    cap = max(0, self._max_series - total_series)
                    omitted = len(metric_cols) - cap
                    metric_cols = metric_cols[:cap]
                    omitted_series += omitted
                    truncated = True

                shaped_values: list[list] = [timestamps]
                for col in metric_cols:
                    points = list(zip(timestamps, col))
                    if len(points) > self._max_points:
                        truncated = True
                        downsampled = _lttb_downsample(points, self._max_points)
                        ts_ds = [p[0] for p in downsampled]
                        v_ds = [p[1] for p in downsampled]
                        shaped_values = [ts_ds]
                        shaped_values.append(v_ds)
                    else:
                        shaped_values.append(list(col))

                shaped_frame = {
                    "schema": schema,
                    "data": {"values": shaped_values},
                }
                shaped_frames.append(shaped_frame)
                total_series += len(metric_cols)

            shaped_results[ref_id] = {**frame_data, "frames": shaped_frames}

        summary = ""
        if omitted_series:
            summary = f"[{omitted_series} series omitted — exceeded cap of {self._max_series}]"

        return ShapedResult(
            data={"results": shaped_results, "_summary": summary} if summary else {"results": shaped_results},
            truncated=truncated,
            raw_bytes=raw_bytes,
            summary=summary,
        )


# ---------------------------------------------------------------------------
# LogsShaper
# ---------------------------------------------------------------------------


def _normalize_template(line: str) -> str:
    """Produce a normalised template by replacing variable parts.

    Args:
        line: A single log line.

    Returns:
        Template string with numbers, UUIDs, and IPs replaced by placeholders.
    """
    # Replace UUIDs
    line = re.sub(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
        "<uuid>",
        line,
        flags=re.IGNORECASE,
    )
    # Replace IPv4 addresses
    line = re.sub(r"\b\d{1,3}(?:\.\d{1,3}){3}\b", "<ip>", line)
    # Replace hex hashes
    line = re.sub(r"\b[0-9a-f]{16,64}\b", "<hash>", line, flags=re.IGNORECASE)
    # Replace numbers (keep short ones like status codes)
    line = re.sub(r"\b\d{5,}\b", "<num>", line)
    # Normalise timestamps
    line = re.sub(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}", "<ts>", line)
    return line.strip()


class LogsShaper:
    """Shapes Loki query results for prompt injection.

    Applies head+tail sampling with a byte cap, and computes a
    top-k template summary for pattern awareness.
    """

    def __init__(
        self,
        max_head: int = DEFAULT_MAX_LOG_LINES_HEAD,
        max_tail: int = DEFAULT_MAX_LOG_LINES_TAIL,
        max_bytes: int = DEFAULT_MAX_LOG_BYTES,
        top_k_templates: int = DEFAULT_TOP_K_TEMPLATES,
    ) -> None:
        self._max_head = max_head
        self._max_tail = max_tail
        self._max_bytes = max_bytes
        self._top_k = top_k_templates

    def shape(self, grafana_response: dict[str, Any]) -> ShapedResult:
        """Shape a Grafana datasource query response for logs.

        Args:
            grafana_response: Raw ``/api/ds/query`` JSON response from Loki.

        Returns:
            ShapedResult with head/tail sample and template summary.
        """
        raw_bytes = len(json.dumps(grafana_response, default=str).encode())
        results = grafana_response.get("results", {})
        all_lines: list[str] = []

        for ref_data in results.values():
            for frame in ref_data.get("frames", []):
                values = frame.get("data", {}).get("values", [])
                # Loki frames: values[0]=timestamps, values[1]=log lines
                if len(values) >= 2:
                    all_lines.extend(str(line) for line in values[1])

        truncated = len(all_lines) > (self._max_head + self._max_tail)

        # Head + tail sampling
        if truncated:
            sampled = all_lines[: self._max_head] + all_lines[-self._max_tail :]
            omitted = len(all_lines) - self._max_head - self._max_tail
        else:
            sampled = all_lines
            omitted = 0

        # Byte cap
        byte_capped = False
        total_bytes = 0
        byte_sampled: list[str] = []
        for line in sampled:
            line_bytes = len(line.encode())
            if total_bytes + line_bytes > self._max_bytes:
                byte_capped = True
                break
            byte_sampled.append(line)
            total_bytes += line_bytes

        if byte_capped:
            truncated = True
            sampled = byte_sampled

        # Top-k template summary
        templates: Counter[str] = Counter(_normalize_template(line) for line in all_lines)
        top_templates = [
            {"template": tmpl, "count": count}
            for tmpl, count in templates.most_common(self._top_k)
        ]

        summary_parts: list[str] = []
        if omitted > 0:
            summary_parts.append(f"{omitted} lines omitted (head/tail sampling)")
        if byte_capped:
            summary_parts.append(f"byte cap {self._max_bytes // 1024}KB reached")

        summary = "; ".join(summary_parts)

        shaped_data = {
            "lines": sampled,
            "total_lines": len(all_lines),
            "top_templates": top_templates,
        }
        if summary:
            shaped_data["_summary"] = summary

        return ShapedResult(
            data=shaped_data,
            truncated=truncated,
            raw_bytes=raw_bytes,
            summary=summary,
        )


# ---------------------------------------------------------------------------
# TracesShaper
# ---------------------------------------------------------------------------


class TracesShaper:
    """Shapes Tempo/Jaeger trace query results for prompt injection.

    Extracts a span tree summary and the slowest execution path.
    """

    def __init__(self, max_spans: int = DEFAULT_MAX_SPANS) -> None:
        self._max_spans = max_spans

    def shape(self, grafana_response: dict[str, Any]) -> ShapedResult:
        """Shape a Grafana datasource query response for traces.

        Args:
            grafana_response: Raw ``/api/ds/query`` JSON response from Tempo.

        Returns:
            ShapedResult with span-tree summary and slowest path.
        """
        raw_bytes = len(json.dumps(grafana_response, default=str).encode())
        results = grafana_response.get("results", {})
        all_spans: list[dict[str, Any]] = []

        for ref_data in results.values():
            for frame in ref_data.get("frames", []):
                # Tempo returns spans as columnar data
                schema = frame.get("schema", {})
                data = frame.get("data", {})
                fields = {
                    f["name"]: idx
                    for idx, f in enumerate(schema.get("fields", []))
                }
                values = data.get("values", [])

                if not fields or not values:
                    continue

                n_rows = len(values[0]) if values else 0
                for i in range(min(n_rows, self._max_spans)):
                    span: dict[str, Any] = {}
                    for name, idx in fields.items():
                        if idx < len(values) and i < len(values[idx]):
                            span[name] = values[idx][i]
                    all_spans.append(span)

        truncated = len(all_spans) >= self._max_spans
        used_spans = all_spans[: self._max_spans]

        # Sort by duration descending for the slowest-path extraction
        def _duration(s: dict[str, Any]) -> float:
            return float(s.get("duration", s.get("durationMs", 0)) or 0)

        sorted_spans = sorted(used_spans, key=_duration, reverse=True)
        slowest = sorted_spans[:10]  # top 10 slowest spans

        shaped_data = {
            "span_count": len(used_spans),
            "total_spans": len(all_spans),
            "slowest_spans": [
                {
                    "name": s.get("spanName", s.get("name", "unknown")),
                    "service": s.get("serviceName", s.get("service", "unknown")),
                    "duration_ms": _duration(s),
                }
                for s in slowest
            ],
            "spans_sample": used_spans[:20],  # first 20 for context
        }

        if truncated:
            shaped_data["_summary"] = (
                f"{len(all_spans)} total spans; capped at {self._max_spans}"
            )

        return ShapedResult(
            data=shaped_data,
            truncated=truncated,
            raw_bytes=raw_bytes,
            summary=shaped_data.get("_summary", ""),
        )


# ---------------------------------------------------------------------------
# Unified shape helper
# ---------------------------------------------------------------------------


async def shape_and_store(
    session_id: str,
    tool_name: str,
    raw_response: dict[str, Any],
    shaper_type: str = "metrics",
    max_series: int = DEFAULT_MAX_SERIES,
    max_points: int = DEFAULT_MAX_POINTS_PER_SERIES,
    max_head: int = DEFAULT_MAX_LOG_LINES_HEAD,
    max_tail: int = DEFAULT_MAX_LOG_LINES_TAIL,
    max_bytes: int = DEFAULT_MAX_LOG_BYTES,
    max_spans: int = DEFAULT_MAX_SPANS,
) -> ToolResult:
    """Shape a raw Grafana response and store the drill-down result if truncated.

    Args:
        session_id: Owning session (for drill-down storage).
        tool_name: Tool that produced the data.
        raw_response: Raw Grafana API response.
        shaper_type: ``"metrics"`` | ``"logs"`` | ``"traces"``.
        max_series: Override for MetricsShaper.
        max_points: Override for MetricsShaper.
        max_head: Override for LogsShaper.
        max_tail: Override for LogsShaper.
        max_bytes: Override for LogsShaper.
        max_spans: Override for TracesShaper.

    Returns:
        ToolResult with shaped data and optional drill_down_handle.
    """
    if shaper_type == "logs":
        shaper = LogsShaper(max_head=max_head, max_tail=max_tail, max_bytes=max_bytes)
    elif shaper_type == "traces":
        shaper = TracesShaper(max_spans=max_spans)
    else:
        shaper = MetricsShaper(max_series=max_series, max_points=max_points)

    shaped = shaper.shape(raw_response)
    handle: str | None = None

    if shaped.truncated:
        handle = await _store_drill_down(session_id, tool_name, raw_response)

    return ToolResult(
        data=shaped.data,
        truncated=shaped.truncated,
        drill_down_handle=handle,
        source="untrusted_telemetry",
        raw_bytes=shaped.raw_bytes,
    )
