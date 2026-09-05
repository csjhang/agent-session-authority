# Week 3 writeup — AHP, Ably, acp-mux + compose

**When:** 2026-09-06 ~02:30 Asia/Taipei (UTC+8)

## Delivered

1. **`packages/adapters/ahp`** — VS Code Agent Host / AHP fixture mock peer
   - Multi-client subscribe, serverSeq envelopes, in-process first-wins tool confirmation, weak turn ownership, host-process-death gap
   - CLI `--mode fixture`; live stub documents `AHP_WS_URL` attach (not required for Week 3)
   - Targets: `targets/vscode-agent-host/`

2. **`packages/adapters/ably`** — Ably AI Transport fixture (preferred)
   - Durable HITL suspend/approval, first-response-wins, reconnect survival, resume=new-invocation gap
   - Optional live path gated on `ABLY_API_KEY`; missing key does **not** fail Week 3
   - Documents **cloud-only / no air-gap / no self-host**
   - Targets: `targets/ably/`

3. **`packages/adapters/acp-mux`** — ACP-family second target
   - RFD #533 observation attach + pending permission re-issue
   - Explicit non-claims: **no fencing / lease / digest / generation / revocation**
   - Targets: `targets/acp-mux/`

4. **`docker/compose.yaml`** — lean third-party repro (sink only; no Temporal/relay)

5. Results table below + capability vectors under each `targets/*/results/`

## Hard rules kept

- `packages/core` has zero AHP/Ably/ACP SDK deps
- No secrets in repo
- Adapter package tests green (vitest)
- No relay code
- Node engines >=20

## Fixture honesty

All three new vectors are `test_basis: synthetic_fixture`. Labels use `not_declared` / `inconclusive` / `underspecified` / `not_tested` — never an unfair pass league table.

## Ably live later

User may inject `ABLY_API_KEY` into the agent process env and extend the live stub; Week 3 ships fixture-only wire capture.

## Docker

```bash
docker compose -f docker/compose.yaml up
curl http://localhost:8787/health
```

See `results-table.md` for the comparison matrix.
