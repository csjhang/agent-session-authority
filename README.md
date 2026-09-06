# agent-session-authority

**Session Authority Fault Probe** — measure who can act, what was approved, and what stays valid across people, devices, runtimes, and restarts.

This is a **Fault Probe** with reproducible witnesses, not a normative conformance kit and not a product. Results are capability / claim vectors with explicit fixture limits.

CLI: `asa` · License: Apache-2.0 · `packages/core` stays free of target SDKs.

## Live ACP witness (restart / stale grant)

Against `@agentclientprotocol/claude-agent-acp@0.75.1` we recorded a capped live run (`live_capped_ok`):

- Grant a Write approval (`fence_epoch: 1`, history seq **27–29**)
- RuntimeRestart (gen1 → gen2) + `session/load`
- Prior Write/approval path remains replayable — **no generation-bound fence** on that grant

Published artifacts:

- [`targets/claude-agent-acp/results/LIVE_CAPPED.md`](targets/claude-agent-acp/results/LIVE_CAPPED.md) — short writeup
- [`targets/claude-agent-acp/results/history-live-witnesses.jsonl`](targets/claude-agent-acp/results/history-live-witnesses.jsonl) — slim witness JSONL

Verbose full `history-live.jsonl` is **not** published; reproduce locally if you need the raw stream:

```bash
pnpm install
# pin / PATH: @agentclientprotocol/claude-agent-acp@0.75.1
export ANTHROPIC_API_KEY=…   # never commit
pnpm --filter @asa/adapter-acp exec tsx src/cli.ts --mode live --scenario capped
```

Initialize-only live (no AUTH scenarios):

```bash
pnpm --filter @asa/adapter-acp exec tsx src/cli.ts --mode live
```

## Quick start (fixtures)

```bash
pnpm install
pnpm test
pnpm asa -- check corpus/auth02/pass.jsonl --profile corpus/auth02/profile.json
```

Fixture adapters (no cloud keys):

```bash
pnpm fixture:acp
pnpm fixture:ahp
pnpm fixture:ably
pnpm fixture:acp-mux
```

## What we measure

Profile **v0.2** AUTH scenarios (AUTH-01…08) over a shared history JSONL + `asa check`. Labels include `supported`, `not_declared`, `violation`, `inconclusive`, `underspecified`, and `not_tested` (`not_tested` ≠ `not_declared`).

Build order: history → checker → mock sink → adapters.

## Status

- **Stage 1:** history JSONL, `asa check`, AUTH checkers and corpora; Dogwood generation notes under `findings/`
- **Stage 2:** mock sink, AUTH-02/04/07, ACP fixture adapter
- **Stage 3:** AHP / VS Code Agent Host, Ably, acp-mux fixtures; Docker compose; comparison table
- **Live (capped):** ACP initialize + session/new + permission + restart/`session/load` witnesses (above)

## Docker mock-sink repro

```bash
docker compose -f docker/compose.yaml up
curl http://localhost:8787/health
```

Lean mock-sink only — no Temporal, no managed relay. See `docker/README.md`.

## Findings

- `findings/2026-09-week3/writeup.md`
- `findings/2026-09-week3/results-table.md`
- Targets: `targets/claude-agent-acp/`, `targets/vscode-agent-host/`, `targets/ably/`, `targets/acp-mux/`

Optional live keys (`ANTHROPIC_API_KEY`, `ABLY_API_KEY`, …) stay in the environment — nothing secret is committed.
