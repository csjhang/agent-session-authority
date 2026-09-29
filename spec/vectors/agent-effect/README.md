# Agent-effect JCS vectors (`asa.agent-effect/0.1`)

Offline pass/reject fixtures for [`../agent-effect-attributes.md`](../agent-effect-attributes.md).

## Run

From repo root:

```bash
pnpm exec tsx spec/vectors/agent-effect/verify.ts
pnpm exec vitest run --config spec/vectors/agent-effect/vitest.config.ts
```

Or: `pnpm test:agent-effect` / `pnpm verify:agent-effect`

## Layout

| File | Role |
| --- | --- |
| `pass-*.json` / `reject-*.json` | Single-record structure + JCS hashed form |
| `cross-pass-*.json` / `cross-reject-*.json` / `cross-report-*.json` | Multi-record (JSON array) authority checks |
| `jcs.ts` | Minimal RFC 8785 canonicalizer |
| `profile.ts` | Single-record MUST/exclusion rules |
| `cross-verify.ts` | Cross-record authority verifier |
| `verify.ts` | CLI + shared runners |

## Single-record

Reject coverage: numeric `ts_unix_nano`, missing `action_digest`, integrity key left inside claimed `hashed_form`.

## Cross-record authority

`verifyCrossRecords(records)` checks a set of `AgentEffectRecord` objects:

1. Every `outcome=committed` has a corresponding prior approval (`approval_decision=grant` + `approval_id`).
2. Same `effect_id` keeps a consistent `action_digest`; approval digest equals effect digest.
3. Approval `runtime_generation` equals the landing effect’s `runtime_generation`.
4. `fence_epoch` must not go backwards within a `stream_id`; effect epoch ≥ approval epoch.
5. Committed with no prior approval → `unauthorized_effect`.
6. `outcome=unknown` is listed separately; never treated as committed or failed.
7. Duplicate `sequence_number` → hard `duplicate_sequence`; gaps → soft `sequence_gap` report (do **not** fail `ok`).

Boundary: mutual consistency only — not proof that external effects happened, and not signatures / hash chains.

### Relation to `packages/core` AUTH-01…07

Core checkers operate on fault-probe `HistoryEvent` streams (`approval.grant`, `effect.receipt`, …), not on `AgentEffectRecord` JSONL. Themes overlap (generation, action binding, fencing, unknown terminals) but APIs and wire formats differ, so this suite implements cross-record rules next to the agent-effect vectors rather than reusing auth01–07.

## Gap reports (rule 7)

`cross-report-07-sequence-gap.json` expects `ok: true` with a `sequence_gap` entry. Gaps are labeled and reported; they are not hard violations.
