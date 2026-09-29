# Session Authority Profile v0.2

Fault Probe test basis (2026-09-05; AUTH-02 ACP-shaped rules 2026-09-29). Measures coverage; not a normative industry standard.

## Problem

Across people, devices, runtimes, and restarts: who may act now, who approved what, which action is still valid, and which effect actually happened.

## Invariants (first wave)

| ID | Rule |
| --- | --- |
| AUTH-01a | Declare generation model G0/G1/G2 |
| AUTH-01b | RuntimeGeneration strictly increases across crash, restart, restore-from-backup. When `generation.observe` marks `field_provenance.runtime_generation=derived` (or `issuer_id` ends with `_adapter_`), a supported explanation notes generation was derived by the probe, not target-native — verdict unchanged. |
| AUTH-01c | G1+ issuer != fenced object |
| AUTH-02 | Action-bound approval (see below) |
| AUTH-03a | Scope determinism: publish (actionType,target)->scopeId; no conflicting self-declare |
| AUTH-03b | <=1 valid ControlLease per (scopeId, fenceEpoch) |
| AUTH-03c | Gateway rejects ActionBinding.scopeId outside holder lease; `control.handoff` moves scope; lease `expires_at` must cover receipt ts |
| AUTH-04 | Fencing at effect boundary; after handoff, non-live holder receipt/dispatch is a violation even if fence_epoch is unchanged |
| AUTH-05 | Approval is not control; control is not blanket approval (derive from grant/lease events, not self-reported role) |
| AUTH-06 | No implicit success without trusted **committed** EffectReceipt; unknown/rejected/failed receipts may not support later success; fail!=info |
| AUTH-07 | Deterministic terminal interpretation; restart fault with session_id pairs unfinished effects/tasks; all published `*_wins` rules verified |

AUTH-02/04/07 are implemented checkers (not stubs). Capability vectors remain `not_tested` until live/native evidence exists.

## AUTH-02 — action-bound approval (ACP-shaped)

Evaluated per `effect.receipt` with `outcome=committed`. Prerequisite: any `effect.receipt` is enough (approval.grant is no longer required to enter evaluation).

1. **With `action_digest`:** find the latest `approval.grant` / `approval.deny` before this receipt with the same `action_digest`. `approval.record` never counts.
   - none → violation subtype **`committed_without_grant`**
   - latest deny → violation subtype **`committed_after_deny`**
   - latest grant but `grant.runtime_generation ≠ receipt.runtime_generation` → violation subtype **`cross_generation_grant`**
   - else this receipt counts as supported evidence
2. **No `action_digest` (`binding=unlinked`):** receipt is inconclusive only; explanation notes the committed effect is not linked to any `action.bind` and lists `witness_seqs`
3. **Overall:** any violation → `violation`; else ≥1 receipt as supported evidence → `supported`; else (no committed or all unlinked) → `inconclusive`
4. Existing binding-field compares still apply (`target`, `args`, `policy_version`, `nonce`, `expiry`, and `runtime_generation` when present on both sides)

ACP-shaped golden histories live under `corpus/acp-shaped/` (regenerate via `scripts/generate-acp-shaped-corpus.ts`).

## Generation models

- **G0** Self-issued — runtime bumps gen; no forgery claim
- **G1** External issuer — document persistence/restore/invalidation
- **G2** Attested — external + signature/HSM

Principle: the fenced object must not be the fence-token issuer.

## Result labels

`supported` | `not_declared` | `violation` | `inconclusive` | `underspecified` | `not_tested`

`not_tested` != `not_declared`. Capability vectors only — no A0–A3 grade.

## Vocabulary

ControlLease, RuntimeGeneration, ActionBinding, ActionDigest, ApprovalDecision, FenceToken/FenceEpoch, EffectId, EffectReceipt.
