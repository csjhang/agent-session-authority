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
