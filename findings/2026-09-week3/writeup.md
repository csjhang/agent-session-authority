# Stage 3 writeup — AHP, Ably, acp-mux + compose

(Folder path remains `findings/2026-09-week3/` for history.)

**When:** 2026-09-06 ~02:30 Asia/Taipei (UTC+8); live note refreshed later same day

## Delivered

1. **`packages/adapters/ahp`** — VS Code Agent Host / AHP fixture mock peer
   - Multi-client subscribe, serverSeq envelopes, in-process first-wins tool confirmation, weak turn ownership, host-process-death gap
   - CLI `--mode fixture`; live stub documents `AHP_WS_URL` attach (not required for Stage 3 fixtures)
   - Targets: `targets/vscode-agent-host/`

2. **`packages/adapters/ably`** — Ably AI Transport fixture (preferred)
   - Durable HITL suspend/approval, first-response-wins, reconnect survival, resume=new-invocation gap
   - Optional live path gated on `ABLY_API_KEY`; missing key does **not** fail Stage 3 fixtures
   - Documents **cloud-only / no air-gap / no self-host**
   - Targets: `targets/ably/`

3. **`packages/adapters/acp-mux`** — ACP-family second target
   - RFD #533 observation attach + pending permission re-issue
   - Explicit non-claims: **no fencing / lease / digest / generation / revocation**
   - Targets: `targets/acp-mux/`

4. **`docker/compose.yaml`** — lean third-party repro (sink only; no Temporal/relay)

5. Results table + capability vectors under each `targets/*/results/`

## Live ACP (capped) — same calendar day

Against `@agentclientprotocol/claude-agent-acp@0.75.1` a capped live run scored `live_capped_ok`:

- Write approval grant (history seq **27–29**, `fence_epoch: 1`)
- RuntimeRestart gen1→gen2 + `session/load` replayed prior session history (A); the same Write `toolCallId` is not a new execution. (B) new-runtime authorization and (C) a new effect are not demonstrated.
- AUTH-04 partial (post-restart write timeout; `session/cancel` method-not-found)

Published: [`LIVE_CAPPED.md`](../../targets/claude-agent-acp/results/LIVE_CAPPED.md) + [`history-live-witnesses.jsonl`](../../targets/claude-agent-acp/results/history-live-witnesses.jsonl). Outbound: [claude-agent-acp#1094](https://github.com/agentclientprotocol/claude-agent-acp/issues/1094).

See `results-table.md` for the LIVE capped row vs fixture rows.

## Hard rules kept

- `packages/core` has zero AHP/Ably/ACP SDK deps
- No secrets in repo
- Adapter package tests green (vitest)
- No relay code
- Node engines >=20

## Fixture honesty

AHP / Ably / acp-mux vectors are `test_basis: synthetic_fixture`. Labels use `not_declared` / `inconclusive` / `underspecified` / `not_tested` — never an unfair pass league table. Live beyond ACP capped (Ably / AHP / acp-mux wire) was **not** in Stage 3 fixture scope.

## Ably / AHP / acp-mux live later

Optional live stubs remain gated on env (`ABLY_API_KEY`, `AHP_WS_URL`, …). Expanding live coverage waits on maintainer signal from #1094 (Align: don’t expand the probe until then).

## Docker

```bash
docker compose -f docker/compose.yaml up
curl http://localhost:8787/health
```

See `results-table.md` for the comparison matrix.

### Evidence boundary (version and limits)

The live row is specifically `@agentclientprotocol/claude-agent-acp@0.75.1`, `test_basis: live_trace`, captured 2026-09-06. Evidence is limited to replayed history (A), an identical Write `toolCallId`, and a post-restart new Write that remained pending then timed out. No new-runtime authorization acceptance (B) or new effect (C) was observed. Adapter-filled `generation`/`fence_epoch` values are labeled derived/test-injected and do not establish native fencing. `live_capped_ok` is not a stale-approval defect reproduction; insufficient evidence is not “safe”.
