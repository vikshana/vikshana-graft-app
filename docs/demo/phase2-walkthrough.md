# Phase 2 Demo Walkthrough

> **Stale as of commit `61534e4` — steps 2, 3, 5, and 6 no longer work.**
> This walkthrough was written for the Phase 2 UI, before the harness
> Phase 4 hardening pass deleted `app/api/rca_sessions.py` (the backend for
> `POST /rca/start`/`/rca/{id}/refine`/`/rca/{id}/accept`) without a
> replacement. Step 2 ("Trigger a new investigation from the RCA page")
> will 404 on **Start investigation**; steps 3, 5, and 6 (which assume that
> investigation is running) cannot be reached as a result. Step 1 (Sessions
> list) and steps 4/7/8 (SessionPanel/feedback), if a session already
> exists via Slack or auto-triage, are still representative of the current
> UI. See `docs/manual-verification.md` § 6 and
> `services/orca/backend/AGENTS.md` for the current, accurate state.

Step-by-step walkthrough of the Phase 2 Session UI.

## Prerequisites

```bash
# Start the full stack
npm run server

# Confirm everything is healthy
./scripts/smoke-dev-env.sh
```

Grafana: http://localhost:3000 (admin / admin)
Langfuse: http://localhost:4100 (admin@dev.local / admin123)

---

## 1. Open Sessions list

1. Log in to Grafana at http://localhost:3000
2. Navigate to **Apps → Graft AI Assistant** in the left sidebar
3. Click **Sessions** in the nav (newly added in Phase 2)
4. Confirm the sessions list page loads at `/a/vikshana-graft-app/sessions`

Expected: table with "No sessions yet" message (or existing sessions if any).

---

## 2. Trigger a new investigation from the RCA page

1. Click **Root Cause Analysis** in the nav
2. In the RCA list, click **New investigation** (or navigate to `/a/vikshana-graft-app/rca/investigate/new`)
3. Fill in:
   - Alert name: `HighErrorRate`
   - Description: `Error rate > 5% on checkout-service`
   - Service: `checkout-service`
   - Environment: `production`
4. Click **Start investigation**

Expected: SSE stream begins, step indicators appear (data_gathering → historical_context → hypothesis_generation).

---

## 3. Watch the investigation run

In the `RCAInvestigate` panel (existing page):
- Step indicators tick through `data_gathering`, `historical_context`, `hypothesis_generation`
- Tool calls appear as the agent queries Mimir/Loki
- Hypothesis is surfaced with confidence score and suggested questions

---

## 4. Open the same session in the new SessionPanel

1. Return to **Sessions** list
2. Click the session row that was just created
3. Confirm the session detail page opens at `/a/vikshana-graft-app/sessions/:id`

Expected: SessionPanel renders with the tool call feed and current hypothesis visible.

---

## 5. Test the ApprovalModal

To trigger an approval request, the agent must call `create_silence` or `create_annotation`. If the investigation reaches this point:

1. The `ApprovalModal` appears with the tool details
2. Review the input JSON
3. Click **Approve**
4. Confirm the agent continues after approval

To force this in dev: the agent can be prompted to create a silence as part of the investigation (set the alert context to something that includes active alerts).

---

## 6. Send a follow-up question

1. In the SessionPanel, type a question in the input box
2. Click **Send**
3. Watch the agent refine its hypothesis in response

Expected: `agent_busy` banner appears briefly while the previous turn is processing, then the new hypothesis appears.

---

## 7. Accept the hypothesis

1. Click **Accept hypothesis**
2. Watch the final report generate
3. The `FeedbackWidget` appears

---

## 8. Submit feedback and verify in Langfuse

1. Click thumbs-up or thumbs-down
2. Optionally add a comment
3. Click **Submit**

Expected: "Thanks for your feedback!" confirmation.

4. Navigate to Langfuse at http://localhost:4100
5. Open the `orca-dev` project
6. Find the session trace (matching session ID)
7. Confirm the feedback score appears as a score on the trace

---

## 9. Verify token redaction

```bash
# Check orca-backend logs for any leaked tokens
docker compose logs orca-backend 2>&1 | grep -E "(eyJ|glsa_|xoxb-)" | head -5
# Expected: no output
```

---

## Checklist

- [ ] Sessions nav item appears in sidebar
- [ ] `/sessions` list page renders
- [ ] Session row click navigates to `/sessions/:id`
- [ ] Tool call feed renders with step indicators
- [ ] Hypothesis panel shows text and suggested questions
- [ ] ApprovalModal appears for write-class tool calls (initiator only)
- [ ] `agent_busy` banner shows when concurrent turn is detected
- [ ] `budget_exceeded` banner shows when budget is hit
- [ ] FeedbackWidget submits to `/sessions/{id}/feedback`
- [ ] Feedback score visible in Langfuse
- [ ] No token prefixes in orca-backend logs
