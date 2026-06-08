# Graft failure export (operator workflow)

When Graft hits a known failure pattern, it appends a row to **browser localStorage** (`graft-operator-failures`).

## Export from the Graft UI (build 145+)

1. Open **Graft AI Assistant** in Grafana.
2. Reproduce or review a failure (programmatic error, LLM stall, `[full-llm]` error).
3. Click **Export failures (N)** in the chat header (highlights when N > 0).
4. **Copy markdown** or **Download .md / .json** and paste into Cursor.

The report includes:

- Timestamp, build, intent path, error text, user message preview
- **Suggested programmatic registry rows** — deduped stubs for `PROGRAMMATIC_FALLBACK_REGISTRY` with:
  - `kind`, triggers, handler
  - Files to implement (`*Parse.ts`, `programmatic*.ts`, `programmaticLlmFallback.ts`)
  - Status: `wired (fast path)`, `wired (LLM fallback)`, or **missing — add handler**

## When failures are logged

- Programmatic path errors (panel copy, rebuild, peer-band fix, etc.)
- LLM stall after auto-continue (clarifying questions, leaked `<function_calls>`, no save)
- Uncaught `[full-llm]` errors (rate limits show actionable text in chat)

Successful **programmatic repair** after an LLM stall is not logged as a failure.

## DevTools fallback

```javascript
copy(localStorage.getItem('graft-operator-failures') || '[]')
```

Do not commit exported logs if they contain tokens or secrets.

## Grafana datasource (future)

See prior notes: Infinity JSON URL, Influx POST, or Loki sidecar if you want a server-side failure dashboard.
