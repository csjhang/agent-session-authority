# agent-session-authority

**Session Authority Fault Probe** — measure who can act, what was approved, and what stays valid across people, devices, runtimes, and restarts.

This is a **Fault Probe** with reproducible witnesses, not a normative conformance kit and not a product. Results are capability / claim vectors with explicit fixture limits.

CLI: `asa` · License: Apache-2.0 · `packages/core` stays free of target SDKs.

## Current status (pin 0.75.1)

Live work targets `@agentclientprotocol/claude-agent-acp@0.75.1`. Generation re-ask chasing on this pin is **paused**. Outbound [claude-agent-acp#1094](https://github.com/agentclientprotocol/claude-agent-acp/issues/1094) is **closed** (no reproducible authorization defect; history replay on `session/load` is resume UX, not a stale grant authorizing a new effect).

### Live permission-axis results (Write)

Score from independent filesystem receipts and native approval events — never from prompt timeout alone. Harness `-32000` on `session/prompt` is a **client wait expiry** (`harness_client_timeout`), not a peer defect verdict.

| Path | Result on this pin |
| --- | --- |
| **allow_once** (restart + new Write) | Post-restart Write gets a **new** `session/request_permission`. Withhold that approval → **no** FS effect. |
| **allow_always** (`allow-with-updates`) | Option offered and selected in gen1. Post-restart Write still gets a **new** approval request — silent always-allow across generation **not observed**. FS effect after a fresh gen2 grant **demonstrated**. |
| **reject_always** | On Write, options were only `allow-once` / `allow-with-updates` (`allow_always`) / `reject` (`reject_once`). **`reject_always` not offered** → durable-deny across generation **not scored**. Treat as **not offered / underspecified**, not a failed test. |

Published reports:

- [`targets/claude-agent-acp/results/AUTH_EFFECT_CHAIN.md`](targets/claude-agent-acp/results/AUTH_EFFECT_CHAIN.md) — auth→effect chain (effect / stale-grant / stale-effect)
- [`targets/claude-agent-acp/results/AUTH_ALWAYS_GRANT_LIVE.md`](targets/claude-agent-acp/results/AUTH_ALWAYS_GRANT_LIVE.md) — hardened always-grant live
- [`targets/claude-agent-acp/results/AUTH_REJECT_ALWAYS_LIVE.md`](targets/claude-agent-acp/results/AUTH_REJECT_ALWAYS_LIVE.md) — reject_always not offered
- [`targets/claude-agent-acp/results/LIVE_CAPPED.md`](targets/claude-agent-acp/results/LIVE_CAPPED.md) — early capped history-replay writeup
- Slim witnesses under `targets/claude-agent-acp/results/history-live-*-witnesses.jsonl` (verbose full histories are gitignored)

### Next probe posture

1. **Option-offer survey** — which permission kinds are actually offered vs listed in the ACP kind enum (Hermes / OpenClaw / …; cheap first pass). See [`findings/option-offer-survey.md`](findings/option-offer-survey.md).
2. Minimal **offline effect-receipt format + verifier** (not hosted audit storage).
3. New public issue for allow/reject option asymmetry only after a quick multi-tool check that `reject_always` is missing beyond Write.

## Reproduce live ACP scenarios

```bash
pnpm install
# pin / PATH: @agentclientprotocol/claude-agent-acp@0.75.1
export ANTHROPIC_API_KEY=…   # never commit

# scenarios: initialize (default) | capped | effect | stale-grant | stale-effect | always-grant | reject-always
pnpm --filter @asa/adapter-acp exec tsx src/cli.ts --mode live --scenario effect
pnpm --filter @asa/adapter-acp exec tsx src/cli.ts --mode live --scenario always-grant
pnpm --filter @asa/adapter-acp exec tsx src/cli.ts --mode live --scenario reject-always
```

Write-probe prompts wait up to 180s client-side by default (override upward with `live_observe_ms`). See `packages/adapters/acp/README.md`.

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

## Stage map

- **Stage 1:** history JSONL, `asa check`, AUTH checkers and corpora; Dogwood generation notes under `findings/`
- **Stage 2:** mock sink, AUTH-02/04/07, ACP fixture adapter
- **Stage 3 (fixtures done):** AHP / VS Code Agent Host, Ably, acp-mux fixtures; Docker compose; comparison table
- **Live ACP (this pin):** permission-axis runs above; generation re-ask expansion **paused**
- **Parked:** further live wire (Ably / AHP / acp-mux) until the option-offer survey and offline-receipt work set the next gate

## Docker mock-sink repro

```bash
docker compose -f docker/compose.yaml up
curl http://localhost:8787/health
```

Lean mock-sink only — no Temporal, no managed relay. See `docker/README.md`.

## Findings

Index: [`findings/README.md`](findings/README.md)

- [`findings/option-offer-survey.md`](findings/option-offer-survey.md) — option-offer survey (Hermes / OpenClaw; Claude ACP contrast)
- [`findings/2026-09-week3/writeup.md`](findings/2026-09-week3/writeup.md)
- [`findings/2026-09-week3/results-table.md`](findings/2026-09-week3/results-table.md)
- Targets: `targets/claude-agent-acp/`, `targets/vscode-agent-host/`, `targets/ably/`, `targets/acp-mux/`

Optional live keys (`ANTHROPIC_API_KEY`, `ABLY_API_KEY`, …) stay in the environment — nothing secret is committed.
