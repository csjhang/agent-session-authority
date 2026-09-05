# Week 2 writeup (2026-09-06 Asia/Taipei)

## Delivered

1. **Mock effect sink** (`packages/sink`) — HTTP server + ledger, zero external deps (`node:http` / `node:crypto`).
   - Accepts `effectId` + `actionDigest`
   - Commit counting + idempotent resend
   - Fault inject: `timeout` / `resend` / `lost_reply` / `delay`
   - Full `EffectReceipt` fields
   - `snapshot` / `restore` — observation log is **not** rolled back
   - Append-only ledger export

2. **Checkers AUTH-02 / AUTH-04 / AUTH-07** with pass+violate corpora and golden tests.

3. **First adapter** `packages/adapters/acp` targeting `@agentclientprotocol/claude-agent-acp@0.75.1`
   - FIXTURE mock ACP peer (default)
   - LIVE spawn path gated on user-provided Anthropic API key in env (never committed)
   - Assessment + capability vector under `targets/claude-agent-acp/`

## How to run sink

```bash
pnpm --filter @asa/sink exec tsx src/cli.ts 8787
# POST http://127.0.0.1:8787/accept {"effectId":"e1","actionDigest":"d1"}
```

Or in-process: `import { MockEffectSink, start_sink_server } from "@asa/sink"`.

## LIVE ACP

Requires `ANTHROPIC_API_KEY` from the user environment. Without it, use FIXTURE mode. Do not put secrets in the repo.

## Test basis note

ACP assessment uses `test_basis: synthetic_fixture` plus public `claim_sources`. This is **not** a vendor violation claim.

## Local verification

- core vitest: 28 passed
- sink vitest: 5 passed
- adapter-acp vitest: 4 passed

## Live ACP measurement attempt (2026-09-06 ~02:05 Asia/Taipei)

### Versions / intent

- Target package: `@agentclientprotocol/claude-agent-acp@0.75.1` (peer/dev optional)
- Adapter: `@asa/adapter-acp@0.2.0`
- Planned command (no secrets): from `packages/adapters/acp`, `pnpm exec tsx src/cli.ts --mode live`
- Planned outputs: `targets/claude-agent-acp/results/history-live.jsonl`, `capability_vector-live.json`
- Keep prior FIXTURE artifacts untouched

### Key presence check

- Confirmed via shell: `ANTHROPIC_API_KEY=missing` (unset; length 0)
- No `.env` / key files in the workspace (by design; secrets must not be committed)
- Adapter gate in `collect_history`: LIVE refuses to spawn without the key

### Outcome

- **LIVE collect did not run.** Stopped at step 1 (key missing).
- Did not install `@agentclientprotocol/claude-agent-acp@0.75.1` (no point without auth).
- Did not write `history-live.jsonl` or `capability_vector-live.json` (no events to check).
- FIXTURE artifacts retained: `history-fixture.jsonl`, `capability_vector.json`.
- Diagnostics: `targets/claude-agent-acp/results/live-status.json`
- `authority-assessment.json` notes updated: LIVE (blocked) vs FIXTURE (prior).

### Limitations / next step for user

- Brief spawn/observe path was never exercised; no protocol handshake observations.
- **User action needed:** inject `ANTHROPIC_API_KEY` into the agent process environment (not the repo), then re-run the live collect steps.
