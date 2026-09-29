# agent-session-authority

**Session Authority Fault Probe** — measure who can act, what was approved, and what stays valid across people, devices, runtimes, and restarts.

This is a **Fault Probe** with reproducible witnesses, not a normative conformance kit and not a product. Results are capability / claim vectors with explicit fixture limits.

CLI: `asa` · License: Apache-2.0 · `packages/core` stays free of target SDKs.

## Current status (pin 0.75.1)

Live work targets `@agentclientprotocol/claude-agent-acp@0.75.1`. Generation re-ask chasing on this pin is **paused**. Outbound [claude-agent-acp#1094](https://github.com/agentclientprotocol/claude-agent-acp/issues/1094) is **closed** (no reproducible authorization defect; history replay on `session/load` is resume UX, not a stale grant authorizing a new effect).

### Live permission-axis results (Write) — WITHDRAWN

Previously published live permission-axis conclusions are **not supported by reproducible evidence**: the published live history does not encode runtime generation, the restart fault, approval↔action binding, or effect receipts, so `asa check` cannot reproduce those conclusions. They are not established. Pending re-run with the fixed adapter. Original writeups are kept as history (not deleted):

- [`AUTH_EFFECT_CHAIN.md`](targets/claude-agent-acp/results/AUTH_EFFECT_CHAIN.md) · [`AUTH_ALWAYS_GRANT_LIVE.md`](targets/claude-agent-acp/results/AUTH_ALWAYS_GRANT_LIVE.md) · [`AUTH_REJECT_ALWAYS_LIVE.md`](targets/claude-agent-acp/results/AUTH_REJECT_ALWAYS_LIVE.md) · [`LIVE_CAPPED.md`](targets/claude-agent-acp/results/LIVE_CAPPED.md)
- Slim witnesses under `targets/claude-agent-acp/results/history-live-*-witnesses.jsonl` (verbose full histories are gitignored)

### Next probe posture

1. **Option-offer survey** — which permission kinds are actually offered vs listed in the ACP kind enum (Hermes / OpenClaw / …; cheap first pass). See [`findings/option-offer-survey.md`](findings/option-offer-survey.md).
2. Minimal **offline effect-receipt format + verifier** (not hosted audit storage) — draft: [`spec/agent-effect-attributes.md`](spec/agent-effect-attributes.md) + JCS vectors under [`spec/vectors/agent-effect/`](spec/vectors/agent-effect/).
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

Profile **v0.2** AUTH scenarios (AUTH-01…08) over a shared history JSONL + `asa check`. Labels include `supported`, `not_declared`, `violation`, `inconclusive`, `underspecified`, and `not_tested` (`not_tested` ≠ `not_declared`). Optional `ts_unix_nano` is a **decimal string** (not a JSON number) so values above `2^53-1` are not rounded by JS parsers — see [`spec/history-format.md`](spec/history-format.md). Draft effect-boundary authority fields (JCS hashed form): [`spec/agent-effect-attributes.md`](spec/agent-effect-attributes.md).

Build order: history → checker → mock sink → adapters.

## Stage map

- **Stage 1:** history JSONL, `asa check`, AUTH checkers and corpora; Dogwood generation notes under `findings/`
- **Stage 2:** mock sink, AUTH-02/04/07, ACP fixture adapter
- **Stage 3 (fixtures done):** AHP / VS Code Agent Host, Ably, acp-mux fixtures; Docker compose; comparison table
- **Live ACP (this pin):** permission-axis live conclusions **withdrawn** (not supported by reproducible evidence; pending re-run with fixed adapter); generation re-ask expansion **paused**
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
- [`spec/agent-effect-attributes.md`](spec/agent-effect-attributes.md) — draft agent-effect authority attributes + offline JCS vectors (research profile)
- [`findings/2026-09-week3/writeup.md`](findings/2026-09-week3/writeup.md)
- [`findings/2026-09-week3/results-table.md`](findings/2026-09-week3/results-table.md)
- Targets: `targets/claude-agent-acp/`, `targets/vscode-agent-host/`, `targets/ably/`, `targets/acp-mux/`

Optional live keys (`ANTHROPIC_API_KEY`, `ABLY_API_KEY`, …) stay in the environment — nothing secret is committed.
