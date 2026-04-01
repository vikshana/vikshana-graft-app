# RCA + Grafana Plugin — Architecture & Merger Brief
> Prepared for Claude Code planning. Covers architecture decisions, implementation details, and phased migration work.

---

## 1. Context: Two Systems to Merge

### System A — Grafana Plugin App
- **Frontend**: React panels inside a Grafana Plugin App
- **Backend**: Go (lightweight, handles chat conversations)
- **Focus**: Interactive chat UI, lives inside Grafana

### System B — RCA System
- **Frontend**: Next.js (to be retired)
- **Backend**: FastAPI + LangGraph
- **Focus**: Automatic Root Cause Analysis, currently one-shot (alert in → report out)

### Merger Goal
Unified UX inside Grafana. Users never leave Grafana. Next.js is decommissioned. Go backend becomes the single API gateway. FastAPI + LangGraph becomes an internal microservice.

---

## 2. Target Architecture

```
GRAFANA (Plugin App — React)
  ├── Chat Panel          (existing)
  └── RCA Panel           (new — investigation UI)
         │
         ▼
Go Backend (Plugin Backend — API Gateway)
  ├── /api/chat/*         (existing)
  ├── /api/rca/*          (new proxy routes → FastAPI)
  └── SSE/WebSocket       (streams LangGraph steps to panel)
         │
    ┌────┴────┐
    ▼         ▼
Chat Svc   FastAPI + LangGraph
(Go)       (internal only, no ingress)
```

**Key principle**: Go is the single auth boundary. The plugin calls one origin. FastAPI is never publicly exposed.

### Kubernetes Deployment
```
grafana                  (existing)
go-plugin-backend        ClusterIP — reachable by Grafana only
fastapi-langgraph        ClusterIP — reachable by Go only
postgres                 ClusterIP — shared checkpointer + RCA store
```
Secrets (LLM API keys, DB creds) via shared `ConfigMap` / `Secret`.

---

## 3. RCA: From One-Shot to Collaborative Investigation

### Old Flow
```
Alert → Agent reasons → Final Report
```

### New Flow
```
Alert → Initial Hypothesis → Developer interrogates → Agent refines → Developer accepts → Final RCA
```

Confidence score is **informational only** — it never gates the loop. The developer always drives. Only two real exit conditions:
1. Developer explicitly accepts (`developer_accepted = true`)
2. Safety ceiling hit (`round >= MAX_ROUNDS`)

---

## 4. LangGraph Graph Design

### Graph Shape
```
[Trigger]
    → [Data Gathering]
    → [Historical Context]     ← retrieves similar past RCAs via pgvector
    → [Hypothesis Generation]
    → [BREAKPOINT: await_input]
         ↑         ↓
    [Refine]   [Finalize]      ← only on developer_accepted or MAX_ROUNDS
```

### Key LangGraph Concepts
- **`interrupt()`** — pauses graph at breakpoint, surfaces hypothesis + confidence
- **`Command(resume=...)`** — injects developer follow-up, resumes graph
- **`thread_id`** — persists session state across HTTP boundaries
- **Checkpointer** — Postgres (shared with RCA store)

### State Schema
```python
class RCAState(TypedDict):
    # RCA context
    alert_context:       AlertContext
    gathered_data:       list[DataPoint]
    hypotheses:          list[Hypothesis]      # append-only, full audit trail
    confidence_scores:   list[float]           # parallel to hypotheses list

    # Loop control
    round:               int
    developer_accepted:  bool                  # ONLY real exit gate
    max_rounds:          int                   # safety ceiling

    # Conversation layer
    messages:            list[BaseMessage]     # full Q&A history
    pending_question:    str | None

    # Output
    final_report:        RCAReport | None
    rca_id:              UUID | None           # set on finalize, links to store
```

### Convergence Logic
```python
def should_continue(state: RCAState) -> str:
    if state.developer_accepted:
        return "finalize"
    if state.round >= state.max_rounds:
        return "force_finalize"              # logs warning in report
    return "await_input"
```

Confidence score is computed each round and stored in `confidence_scores[]` but **never used in routing**.

---

## 5. Go Backend — New RCA API Routes

```
POST   /api/rca/start
       Body: { alert_id, alert_context }
       → creates thread_id, runs graph to first breakpoint
       → returns { thread_id, hypothesis, confidence, suggested_questions }

POST   /api/rca/{thread_id}/refine
       Body: { message }
       → resumes graph via Command(resume=message)
       → streams agent reasoning back via SSE
       → returns { hypothesis, confidence, status: "refining"|"converged" }

POST   /api/rca/{thread_id}/accept
       Body: {}
       → sets developer_accepted = true, resumes to finalize node
       → returns { rca_id, final_report }

GET    /api/rca/{thread_id}/history
       → returns full hypothesis trail + Q&A transcript

GET    /api/rca/search?q=...&service=...&alert_type=...
       → queries RCA knowledge store (structured + semantic)
```

**Streaming**: Go opens SSE connection to FastAPI for `/refine`, proxies events to the Grafana panel. Agent reasoning steps stream in real time.

---

## 6. RCA Panel — UI States

The panel has three phases, always showing the full action bar:

```
┌─────────────────────────────────────────────────┐
│  🔍 RCA Investigation — {alert_name}            │
│  Round {n}  ·  Confidence {x}% {↑/↓} (was {y}%)│
├─────────────────────────────────────────────────┤
│  WORKING HYPOTHESIS                             │
│  "{hypothesis_text}"                            │
│                                                 │
│  ✅ High confidence: {areas}                    │
│  ⚠  Still uncertain: {areas}                   │
├─────────────────────────────────────────────────┤
│  AGENT SUGGESTS                                 │
│  [{suggested_question_1}]                       │
│  [{suggested_question_2}]                       │
├─────────────────────────────────────────────────┤
│  💬 Ask anything...                    [Send]   │
│                                                 │
│  [✓ Accept as Final RCA]                        │
└─────────────────────────────────────────────────┘
```

**Accept button is always visible from round 1.** Developer can override even at low confidence — the final report records this:
```
⚠ RCA accepted at 41% agent confidence. Developer override at Round 1.
```

### Chat / RCA Context Bridge
Keep as separate panels but share `thread_id` context. Chat panel can optionally receive RCA `thread_id` so developers can ask free-form questions about the active investigation.

---

## 7. Storage Architecture

### Two Separate Stores, One Postgres Instance

```
Postgres
  ├── langgraph_checkpoints    ← LangGraph managed, operational/short-lived
  ├── rca_sessions             ← canonical RCA records, long-lived
  └── rca_embeddings           ← pgvector semantic index
```

**Critical boundary**: LangGraph checkpointer handles in-flight sessions. The RCA knowledge store is written **once** on `developer_accepted`. They are separate tables and separate concerns.

### rca_sessions Schema
```sql
CREATE TABLE rca_sessions (
    id                  UUID PRIMARY KEY,
    thread_id           UUID UNIQUE,           -- LangGraph thread ref
    alert_id            TEXT,
    alert_type          TEXT,
    service             TEXT,
    environment         TEXT,
    started_at          TIMESTAMPTZ,
    accepted_at         TIMESTAMPTZ,
    rounds              INT,
    final_confidence    FLOAT,
    developer_override  BOOLEAN,               -- true if accepted at low confidence
    final_hypothesis    TEXT,
    final_report        JSONB,
    hypothesis_trail    JSONB                  -- all rounds, append-only audit log
);
```

### rca_embeddings Schema
```sql
CREATE TABLE rca_embeddings (
    id          UUID PRIMARY KEY,
    rca_id      UUID REFERENCES rca_sessions(id),
    chunk_type  TEXT,    -- 'hypothesis' | 'qa_turn' | 'final_report'
    content     TEXT,
    embedding   vector(1536)
);
```

### What Gets Embedded
- Final accepted hypothesis
- Each Q&A turn (developer question + agent response pair)
- Final report narrative

### Finalize Node (LangGraph)
```python
@graph.node
async def finalize(state: RCAState):
    report = build_final_report(state)
    rca_id = await rca_store.save(report, state)      # write to rca_sessions
    await embedder.index_rca(rca_id, report, state.messages)  # write embeddings
    # LangGraph thread can now be archived/cleaned up
    return { "final_report": report, "rca_id": rca_id }
```

---

## 8. Historical Context in Future Investigations

On every new RCA start, a `[Historical Context]` node runs before hypothesis generation:

```python
async def gather_historical_context(alert: AlertContext) -> list[PastRCA]:
    query_embedding = await embed(alert.description)
    results = await db.fetch("""
        SELECT r.alert_type, r.service, r.final_hypothesis,
               r.final_confidence, r.accepted_at,
               e.embedding <=> $1 AS distance
        FROM rca_embeddings e
        JOIN rca_sessions r ON r.id = e.rca_id
        WHERE e.chunk_type = 'hypothesis'
        ORDER BY distance
        LIMIT 5
    """, query_embedding)
    return results
```

The top-5 similar past RCAs are injected into the hypothesis generation prompt, giving the agent institutional memory from day one.

---

## 9. Migration Phases

### Phase 1 — Bridge (both apps running)
- Add `/api/rca/*` proxy routes to Go backend → existing FastAPI
- Build RCA panel in Grafana plugin using existing Next.js API contract as reference
- Add LangGraph interrupt/resume + Postgres checkpointer
- Add `rca_sessions` + `rca_embeddings` tables + pgvector extension

### Phase 2 — Absorb
- Move shared logic (auth, user context, datasource queries) from Next.js into Go
- Validate 100% of RCA flows work end-to-end through the plugin
- Add SSE streaming from Go → Grafana panel

### Phase 3 — Retire Next.js
- Decommission Next.js frontend and its Kubernetes ingress
- FastAPI + LangGraph becomes fully internal (no public surface)
- Clean up any remaining Next.js references

---

## 10. Key Design Decisions (Rationale for Claude Code)

| Decision | Rationale |
|---|---|
| Go as API gateway, not direct FastAPI calls | Single auth boundary, no CORS, centralised logging |
| Confidence as signal not gate | Developer domain knowledge > agent self-assessment |
| `developer_accepted` as only exit | Keeps developer in full control of investigation lifecycle |
| pgvector in same Postgres as checkpointer | Avoids separate vector DB; simpler infra |
| Hypothesis trail as append-only JSONB | Full audit log for post-mortems; never mutate past rounds |
| Separate checkpointer vs RCA store | Operational vs analytical concerns; different lifecycles |
| Next.js retirement, not refactor | Reduces surface area; all UX lives in Grafana |
