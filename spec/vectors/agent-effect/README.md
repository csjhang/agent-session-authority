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

Reject coverage: numeric `ts_unix_nano`, missing `action_digest`, integrity key left inside claimed `hashed_form`, non-integer / wrong-type / null / empty / unsafe-integer fields (`reject-04`…`07`, `reject-11`…`13`, `reject-16`), and `bad_record_kind` (`reject-08`…`10`, `reject-14`…`15`).

## Cross-record authority

`verifyCrossRecords(records, options?)` checks a set of `AgentEffectRecord` objects. `options.requireIssuance=true` is strict mode.

Approvals are indexed by `approval_id` (not `effect_id`). **Independent issuance only** (`record_kind=approval`, or legacy non-committed decision+id). `outcome=committed` never counts as a decision candidate. Self-declared approval fields on a commit are a claim of use.

1. Every `outcome=committed` resolves to a prior **independent** grant for its `approval_id`, or (loose only) a **legacy** (absent `record_kind`) `approval_decision=grant` self-claim. `record_kind="effect"` claims, `approval_decision` none/deny/missing without issuance → `unauthorized_effect`. Strict (`requireIssuance`) rejects all claim-only → `unauthorized_effect`.
2. Committed + approval records for the same `effect_id` keep a consistent `action_digest`; approval digest equals effect digest. `rejected`/`failed` digest divergence → soft `rejected_digest_variant`.
3. Issuance generation from **independent issuance** must equal landing `runtime_generation`. Self-declared generation on the commit must not override issuance (`cross-reject-09` / `cross-reject-10`) but can only make the check stricter: commit `approval_runtime_generation` ≠ own `runtime_generation` → always `cross_generation_reuse` even with issuance (`cross-reject-24`). No issuance → soft `approval_generation_unverifiable`; self-admitted mismatch → also hard `cross_generation_reuse` (`cross-reject-11`).
4. `fence_epoch` must not go backwards within a `stream_id`; effect epoch ≥ approval epoch.
5. Latest prior independent decision wins: deny then commit same id → `revoked_approval_used` (including “reclaim on commit”). Effect-level deny (other id) → `committed_after_deny`. Grant issued for another `effect_id` → `approval_effect_mismatch`. Same `approval_id` on multiple committed effects → `approval_reused_across_effects`. Multiple commits → `duplicate_commit`. Deny then **fresh** grant then commit → pass (`cross-pass-10-deny-then-fresh-grant`).
6. `outcome=unknown` with `record_kind`≠`approval` is listed separately; never treated as committed or failed. `record_kind=approval` issuances are omitted from the unknowns list.
7. Duplicate `sequence_number` → hard `duplicate_sequence`; gaps → soft `sequence_gap` report (do **not** fail `ok`).

Ordering: **priorness** vs **pick latest** are separate. Cross-stream priorness = `order_ts` only (equal = prior; no stream_id/seq/JCS). Pick latest uses per-stream heads at max `order_ts`; fail-closed only when heads disagree grant+deny. Soft `stream_ts_regression`. Vectors are permutation-invariant (see `verify.test.ts`).

Boundary: mutual consistency only — not proof that external effects happened, and not signatures / hash chains.

### Relation to `packages/core` AUTH-01…07

Core checkers operate on fault-probe `HistoryEvent` streams (`approval.grant`, `effect.receipt`, …), not on `AgentEffectRecord` JSONL. Themes overlap (generation, action binding, fencing, unknown terminals) but APIs and wire formats differ, so this suite implements cross-record rules next to the agent-effect vectors rather than reusing auth01–07.

## Gap reports (rule 7)

`cross-report-07-sequence-gap.json` expects `ok: true` with a `sequence_gap` entry. Gaps are labeled and reported; they are not hard violations.

## Cross-record limits

- Sequence gaps use **adjacent differences** only (no min→max integer walk).
- Cross-stream priorness uses monotonic-max `order_ts` only (equal = prior); pick-latest uses stream heads. `ts_unix_nano` is a reference clock only — not causal order. See the Cross-record section in the attribute draft.
