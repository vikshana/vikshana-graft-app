# ADR-005: Langfuse for LLM Eval Tracking

**Date:** 2026-07-04
**Status:** Accepted

## Context

LLM outputs need to be tracked for quality regression, prompt iteration, and eval-regression CI. Options: LangSmith (already in config), Langfuse (self-hostable, OTLP-native).

## Decision

Use Langfuse. Add to dev compose as a self-hosted instance. Fan out OTel traces from orca-backend to Langfuse's OTLP endpoint via the otel-collector.

Rationale: Langfuse is self-hostable (no SaaS dependency in CI), supports OTLP ingestion (reuses existing pipeline), and has a dataset/eval API for the CI eval-regression job.

LangSmith remains available via existing LANGCHAIN_TRACING_V2 flag for operators who prefer it.

## Consequences

- dev compose gains ~4 containers (langfuse-web, langfuse-worker, langfuse-postgres, langfuse-clickhouse, langfuse-redis)
- Initial startup takes longer; this is acceptable in dev
- `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are required config (defaults provided for dev)
- The CI eval-regression job requires Langfuse to be reachable (use self-hosted in CI or skip with dev defaults)
