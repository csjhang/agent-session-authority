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

### Live re-run (PR-7b)

Re-run date: **2026-09-30**. Pin `@agentclientprotocol/claude-agent-acp@0.75.1`. The earlier live permission-axis conclusions (2026-09-06..14) remain **WITHDRAWN** and are not used as evidence.

**Runs:** included **13**, excluded **0** — by scenario: effect 3, stale-grant 3, stale-effect 3, always-grant 3, reject-always 1. Evidence is under `targets/claude-agent-acp/results/live-runs/<scenario>/<run-id>/`.

**observed_vector** (promoted from live; AUTH-07 excluded as probe-derived):

| invariant | observed |
| --- | --- |
| AUTH-02 | supported |
| AUTH-03a | inconclusive |
| AUTH-03b | inconclusive |
| AUTH-03c | inconclusive |
| AUTH-04 | inconclusive |
| AUTH-05 | inconclusive |
| AUTH-07 | not_tested |

**capability_vector** (same invariants; `not_declared` = observed but not graded — no vendor profile; `research_profile`):

| invariant | capability |
| --- | --- |
| AUTH-02 | not_declared |
| AUTH-03a | inconclusive |
| AUTH-03b | inconclusive |
| AUTH-03c | inconclusive |
| AUTH-04 | inconclusive |
| AUTH-05 | inconclusive |
| AUTH-07 | not_tested |

**capability_exclusions:** AUTH-01a, AUTH-01b, AUTH-01c, AUTH-06, AUTH-07, AUTH-08 are not promoted from live; see [Capability vectors](#capability-vectors).

**Disagreements:** none. **Excluded runs:** none.

No conclusion beyond these generated fields is claimed; evidence is in targets/claude-agent-acp/results/live-runs/.

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
# live output: targets/claude-agent-acp/results/live-runs/<scenario>/<run-id>/{history.jsonl,run.json,peer-events.jsonl}
# inspect run.json run_valid (exit 0 = valid, exit 2 = invalid / write refused)
pnpm --filter @asa/adapter-acp exec tsx src/cli.ts --mode live --scenario effect --run-id demo-effect-1
pnpm --filter @asa/adapter-acp exec tsx src/cli.ts --mode live --scenario always-grant --run-id demo-always-1
pnpm --filter @asa/adapter-acp exec tsx src/cli.ts --mode live --scenario reject-always --run-id demo-reject-1
```

Write-probe prompts wait up to 180s client-side by default. `live_observe_ms`, `effect_grace_ms`, and `always_grant_poll_ms` are `collect_history` options only (no CLI flags). See `packages/adapters/acp/README.md`.

**Live history `runtime_generation`:** derived by the probe from process spawn count (`issuer_id=acp_adapter_live`), not from native target generations. Under this encoding, AUTH-01b / AUTH-01c only validate the probe itself — they are not evidence of native RuntimeGeneration support in claude-agent-acp.

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

Profile **v0.2** AUTH scenarios (AUTH-01…08) over a shared history JSONL + `asa check`. AUTH-01…07 implemented; AUTH-08 defined, unimplemented (always `not_tested`). Labels include `supported`, `not_declared`, `violation`, `inconclusive`, `underspecified`, and `not_tested` (`not_tested` ≠ `not_declared`). Optional `ts_unix_nano` is a **decimal string** (not a JSON number) so values above `2^53-1` are not rounded by JS parsers — see [`spec/history-format.md`](spec/history-format.md). Draft effect-boundary authority fields (JCS hashed form): [`spec/agent-effect-attributes.md`](spec/agent-effect-attributes.md).

Build order: history → checker → mock sink → adapters.

## CLI (`asa check`)

From repo root: `pnpm asa -- check <history.jsonl> [--profile path] [--assessment path] [--json]`.

Paths are resolved relative to the process cwd only (no `../..` guesses). Prefer running from the repo root so `corpus/...` paths work.

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | No `finding.result` is `violation` (post claim-rewrite; rewritten `not_declared` does not count as failure) |
| 1 | At least one `finding.result` is `violation` |
| 2 | Tool error (missing args, unknown command/flag, flag missing value, missing file, JSON/schema/history parse failure, unexpected exception) |

`--json` prints only the `build_report` JSON on stdout (no text report). Default stdout is the text report only; use `--json` for JSON.

## Capability vectors

`pnpm generate:capability-vectors` rewrites `targets/<target>/results/capability_vector.json`.

- `fixture_vector` — `asa check` on the committed fixture history (adapter + checker self-consistency). Never target capability.
- `capability_vector` — target capability from live runs only, claim-rewritten under `capability_basis` (`null` until a live run is included). claude-agent-acp has no vendor profile and uses `research_profile`, so an observed `supported` / `violation` is shown as `not_declared` (not graded); see `observed_vector` for the raw result.
- `observed_vector` — aggregated live `observed_result` per invariant.
- `capability_sources` — repo-relative live `history.jsonl` paths behind every non-`not_tested` label.
- `live_runs` — included runs (with per-run observed results), excluded runs (with reasons) and disagreements.

`pnpm reconvert:live-runs` checks that each live run's `history.jsonl` is byte-for-byte what the current ACP adapter derives from the run's `peer-events.jsonl` (the recorded ACP traffic), and that `run.json` counts match both files; CI runs the same check in `packages/adapters/acp/test/live-reconvert.test.ts`. After an adapter change, `pnpm reconvert:live-runs -- --write` regenerates `history.jsonl` (and `run.json` `history_events`) from the recorded peer events; `peer-events.jsonl` is never modified.

Live aggregation (claude-agent-acp, `targets/claude-agent-acp/results/live-runs/<scenario>/<run-id>/`):

1. A run counts only if `run.json` has `run_valid: true` and `package_version_observed: "0.75.1"` and `history.jsonl` parses; anything else is listed under `live_runs.excluded` with reasons.
2. Within a scenario every run must agree. A disagreement is listed in `live_runs.disagreements` exactly as observed — never a majority vote.
3. Across scenarios: a consistent `violation` anywhere wins; otherwise any disagreement makes the invariant `inconclusive`; otherwise a consistent `supported`; otherwise `inconclusive`.
4. `capability_exclusions` lists invariants never promoted from these live runs: AUTH-01a (profile-only), AUTH-01b / AUTH-01c (generation is counted by the adapter itself), AUTH-06 (the adapter does not map the agent's success claims), AUTH-07 (the adapter maps none of the agent's terminal status; the only terminal events are its own receipts and the restart it injects), AUTH-08 (no checker).

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
