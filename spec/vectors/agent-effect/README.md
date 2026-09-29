# Agent-effect JCS vectors (`asa.agent-effect/0.1`)

Offline pass/reject fixtures for [`../agent-effect-attributes.md`](../agent-effect-attributes.md).

## Run

From repo root:

```bash
pnpm exec tsx spec/vectors/agent-effect/verify.ts
pnpm exec vitest run --config spec/vectors/agent-effect/vitest.config.ts
```

Or: `pnpm test:agent-effect`

## Layout

| File | Role |
| --- | --- |
| `pass-*.json` | Valid records + pinned `expected_jcs` / `expected_jcs_sha256` |
| `reject-*.json` | Invalid records with `reject_code` |
| `jcs.ts` | Minimal RFC 8785 canonicalizer |
| `profile.ts` | MUST/exclusion rules |
| `verify.ts` | CLI + shared runner |

Reject coverage: numeric `ts_unix_nano`, missing `action_digest`, integrity key left inside claimed `hashed_form`.
