# Graft failure log → Grafana

When a programmatic Graft action fails (panel JSON paste, cross-dashboard panel copy, etc.), the app appends a row to **local browser storage** (`graft-operator-failures`).

## Export from the browser (today)

1. Open Grafana with Graft, reproduce the failure.
2. Open DevTools → **Console**.
3. Run:

```javascript
copy(localStorage.getItem('graft-operator-failures') || '[]')
```

4. Paste into a file `graft-failures.json` for debugging in the repo or with Cursor.

For Markdown:

```javascript
// After deploying build with exportGraftFailuresAsMarkdown wired in UI, or:
JSON.parse(localStorage.getItem('graft-operator-failures')||'[]').forEach(e => console.log(e.at, e.intent, e.error))
```

## Grafana “page” (recommended next step)

Grafana needs a **datasource** for failures. Options:

| Approach | Effort | Notes |
|----------|--------|-------|
| **Infinity + JSON URL** | Low | Host `graft-failures.json` on S3/nginx; table panel |
| **Influx `graft_operator_failures`** | Medium | Small POST from Graft plugin on failure |
| **Loki** | Medium | Ship JSON lines from a sidecar |

Until a server sink exists, use **chat history** (Graft already saves sessions) plus the localStorage export above when fixing parsers (e.g. `2026-05` date vs machine id).

## What we log

- Timestamp, build number, intent (`panel_json_duplicate`, `single_panel_copy`, …)
- Error text, dashboard/panel titles when known
- First 2000 chars of the user message (includes pasted panel JSON)

Do not commit exported logs if they contain tokens or secrets.
