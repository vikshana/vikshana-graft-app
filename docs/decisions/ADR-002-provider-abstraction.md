# ADR-002: LLM Provider Abstraction

**Date:** 2026-07-04
**Status:** Accepted

## Context

The existing RCA service uses `langchain_anthropic.ChatAnthropic` directly in graph nodes. This couples the graph to a single vendor and makes testing require real API calls or complex patching.

## Decision

Define an `LLMProvider` protocol in `harness/llm/provider.py`. All harness graph nodes call the protocol; never vendor SDKs directly. Implementations: `AnthropicProvider`, `OpenAICompatProvider`, `FakeProvider`.

Provider selected via config (`LLM_PROVIDER`, `LLM_MODEL`). Hot-swappable per deployment.

The existing `app/agent/rca_graph.py` continues to use `ChatAnthropic` directly until Phase 4 retirement. New harness graphs use the protocol from day one.

## Consequences

- All new harness code is vendor-agnostic
- `FakeProvider` enables deterministic, offline testing for all graph scenarios
- `FakeProvider.recorded_prompts()` enables injection red-team tests (Phase 1.3)
- Switching from Anthropic to Azure OpenAI = change one config variable, no code change
