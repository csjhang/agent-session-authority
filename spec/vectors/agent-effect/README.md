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

`verifyCrossRecords(records)` checks a set of `AgentEffectRecord` objects.

Approvals are indexed by `approval_id` (not `effect_id`). Self-declared approval fields on a committed record are a claim, not independent issuance evidence.

1. Every `outcome=committed` resolves to a prior grant for its `approval_id` (`approval_decision=grant` + `approval_id`).
2. Same `effect_id` keeps a consistent `action_digest`; approval digest equals effect digest.
3. Approval issuance generation equals the landing effect’s `runtime_generation` (`approval_runtime_generation` when present; else a separate issuance record). Else soft-report `approval_generation_unverifiable`. Cross-generation reuse → `cross_generation_reuse`.
4. `fence_epoch` must not go backwards within a `stream_id`; effect epoch ≥ approval epoch.
5. No prior grant → `unauthorized_effect`. Latest prior decision wins: deny then commit → `revoked_approval_used`. Same `approval_id` on multiple committed `effect_id`s → `approval_reused_across_effects`. Multiple `outcome=committed` for one `effect_id` → `duplicate_commit`.
6. `outcome=unknown` is listed separately; never treated as committed or failed.
7. Duplicate `sequence_number` → hard `duplicate_sequence`; gaps → soft `sequence_gap` report (do **not** fail `ok`).

Boundary: mutual consistency only — not proof that external effects happened, and not signatures / hash chains.

### Relation to `packages/core` AUTH-01…07

Core checkers operate on fault-probe `HistoryEvent` streams (`approval.grant`, `effect.receipt`, …), not on `AgentEffectRecord` JSONL. Themes overlap (generation, action binding, fencing, unknown terminals) but APIs and wire formats differ, so this suite implements cross-record rules next to the agent-effect vectors rather than reusing auth01–07.

## Gap reports (rule 7)

`cross-report-07-sequence-gap.json` expects `ok: true` with a `sequence_gap` entry. Gaps are labeled and reported; they are not hard violations.

## Cross-record limits

- Sequence gaps use **adjacent differences** only (no min→max integer walk).
- Cross-stream prior/later falls back to `ts_unix_nano` as a reference clock only — not causal order. See the Cross-record section in the attribute draft.
