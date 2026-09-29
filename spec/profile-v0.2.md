# Session Authority Profile v0.2

Fault Probe test basis (2026-09-05; AUTH-02 ACP-shaped rules 2026-09-29). Measures coverage; not a normative industry standard.

## Problem

Across people, devices, runtimes, and restarts: who may act now, who approved what, which action is still valid, and which effect actually happened.

## Invariants (first wave)

| ID | Rule |
| --- | --- |
| AUTH-01a | Declare generation model G0/G1/G2. `claim_status` always from `claim_for` (invalid `generation_model` still forces `underspecified`). No profile / no `generation_model`: if AUTH-01a is claimed (including via parent `AUTH-01`) → `underspecified` (`AUTH-01a is claimed but the profile declares no generation_model.`); else `not_declared`. |
| AUTH-01b | RuntimeGeneration strictly increases across crash, restart, restore-from-backup **per generation stream** (`attrs.runtime_id`, else `session_id`; regression only within stream). Restart-class (`runtime.restart` / `runtime.crash` / `state.restore`) maps observes by `runtime_id` match, else `session_id` match, else all; if restart has neither and mapped observes span >1 stream → unexamined. Per mapped stream: nearest numeric observe before + first numeric after (skip non-numeric). Both present = examined; after≤before = violation. Restart examined iff ≥1 stream examined. Order: violation → no restart → unexamined restart → supported. When `generation.observe` marks `field_provenance.runtime_generation=derived` (or `issuer_id` ends with `_adapter_`), a supported explanation notes generation was derived by the probe, not target-native — verdict unchanged. |
| AUTH-01c | Issuer separation order: (1) empty history → `not_tested`; (2) `generation_model` G0 → `supported` (profile-based, empty witnesses); (3) no `generation_model` / no profile → observed `not_declared`; (4) other model → `underspecified`; (5) G1/G2 without `generation.observe` → `inconclusive`; (6) examine only `generation.observe` with `issuer_id` AND (`runtime_id`\|`fenced_object_id`); witness those only. G1/G2 with observes, no violation, zero examined → `inconclusive` empty witness (`no generation.observe carries both issuer_id and runtime_id/fenced_object_id; issuer separation not examined`). |
| AUTH-02 | Action-bound approval (see below) |
| AUTH-03a | Scope determinism: publish (actionType,target)->scopeId; no conflicting self-declare. Examined = `action.bind`/`action.propose` with `action_type`+`target`+`scope_id` matching a published mapping; supported witnesses only examined. No violation and zero examined → `inconclusive` (`no bind with a self-declared scope_id matched a published scope mapping; scope determinism not examined`). |
| AUTH-03b | ≤1 valid ControlLease per (scopeId, fenceEpoch). Contention examined per `scope_id` from all `lease.acquire` (any kind; holder else `actor_id`) and `control.handoff` from/to fields; ≥2 distinct holders = contention (rejected acquires count). Order: violation → no accepted `lease.acquire` → no contended scope → `inconclusive` (`no lease contention examined`) → supported (witness all seqs from contended scopes). |
| AUTH-03c | Gateway rejects ActionBinding.scopeId outside holder lease; `control.handoff` moves scope (if from/predecessor/actor_id all missing → strip scope from all holders except `to`); lease `expires_at` compared via `Date.parse` (numeric); re-acquire without `expires_at` clears old expiry. Track max accepted `fence_epoch` per scope; accepted acquire with epoch **strictly higher** removes that scope from all other holders (drop empty) then update; equal/lower does not remove. Supported requires ≥1 positively evaluated committed receipt; else inconclusive. |
| AUTH-04 | Fencing at effect boundary. Each fence record (per-scope + global) keeps a sticky "was superseded" flag on: epoch up; holder change; any `control.handoff`; `lease.revoke`/`release` raising epoch (`new_fence_epoch`/`stale`/`invalidate_fence`). Attribute receipt/dispatch: matching `scope_id` record → use; else no scope records → global; else no `scope_id` and exactly one scope record → that; else unattributed (no default→global). Unattributed committed when any fence exists is not evidence. Positive committed counts for supported only if attributed record was superseded. Order: violation → no positive committed → positive but none after fence change (`no fence change examined`) → supported. |
| AUTH-05 | Approval is not control; control is not blanket approval (derive from grant/lease events, not self-reported role) |
| AUTH-06 | No implicit success without trusted **committed** EffectReceipt; unknown/rejected/failed receipts may not support later success; fail!=info. Supported requires ≥1 committed receipt evaluated; else inconclusive. |
| AUTH-07 | Deterministic terminal interpretation. Subject order: `effect_id` → `task_id` → `subject_id` → `tool_call_id` → `session_id`. Restart fault with `session_id` pairs unfinished effects/tasks (restart with no open work creates **no** subject). `terminal_rules` values only: `cancel_wins`, `complete_wins`, `timeout_wins`, `restart_wins`, `failed_wins`, `reconcile_required`. Unknown value = not covered (violation notes `unknown rule value <value>` when other rules published); missing rule keeps period ending; `reconcile_required` without observed reconciliation → requires-reconciliation violation. `effect.receipt` outcome maps committed→complete, failed→failed, unknown→unknown (`rejected` is not terminal). Supported requires ≥1 examined-terminal-contention subject (≥2 terminal events **or** terminal includes restart/crash); else inconclusive (`no terminal contention examined`). |
| AUTH-08 | Bypass honesty: If a runtime or tool can bypass the authority enforcement point, the implementation must publicly state its coverage boundary and must not claim end-to-end guarantees. Not implemented: always `not_tested`. Disclosure belongs in `profile.known_bypasses` and `profile.coverage_boundary`. |

AUTH-02/04/07 are implemented checkers (not stubs). Capability vectors remain `not_tested` until live/native evidence exists.

## AUTH-02 — action-bound approval (ACP-shaped)

Evaluated per `effect.receipt` with `outcome=committed` (deduplicated by `effect_id`). Prerequisite: any `effect.receipt` is enough (approval.grant is no longer required to enter evaluation).

1. **With `action_digest`:** find the latest `approval.grant` / `approval.deny` before this receipt with the same `action_digest`. `approval.record` never counts.
   - none → violation subtype **`committed_without_grant`**
   - latest deny → violation subtype **`committed_after_deny`**
   - latest grant but `grant.runtime_generation ≠ receipt.runtime_generation` → violation subtype **`cross_generation_grant`**
   - latest grant with `option_kind=allow_once` already consumed by a different `effect_id` → violation subtype **`once_grant_reused`**
   - else this receipt counts as supported evidence
2. **No `action_digest` (`binding=unlinked`):** receipt is inconclusive only; explanation notes the committed effect is not linked to any `action.bind` and lists `witness_seqs`. When overall is `supported` and unlinked committed receipts also exist, the supported explanation includes unlinked count + `witness_seqs`.
3. **Overall:** any violation → `violation`; else ≥1 receipt as supported evidence → `supported`; else (no committed or all unlinked) → `inconclusive`
4. **Rebound** compares only action-defining fields: `action_type`, `target`, `args`, `policy_version`. Different `nonce` / `runtime_generation` / `expiry` is a **new request for the same action**, not rebound. Receipt vs latest grant generation mismatch remains **`cross_generation_grant`** (binding-field compare set unchanged).

ACP-shaped golden histories live under `corpus/acp-shaped/` (regenerate via `scripts/generate-acp-shaped-corpus.ts`; `generate_acp_shaped_corpus()` export available for in-process tests).

## Generation models

- **G0** Self-issued — runtime bumps gen; no forgery claim
- **G1** External issuer — document persistence/restore/invalidation
- **G2** Attested — external + signature/HSM

Principle: the fenced object must not be the fence-token issuer.

## Result labels

`supported` | `not_declared` | `violation` | `inconclusive` | `underspecified` | `not_tested`

`not_tested` != `not_declared`. Capability vectors only — no A0–A3 grade.

`result` is the claim-rewritten grade; `observed_result` is the checker's raw conclusion. Under `research_profile` / `vendor_claim`, undeclared invariants are **not graded**: `observed_result` `supported` or `violation` rewrites to `result=not_declared` (witnesses and observed outcome kept in explanation). `inconclusive` / `not_tested` are not rewritten. `synthetic_fixture` never rewrites. See `spec/history-format.md` Checker output shape.

Checkers must **not** claim-rewrite undeclared invariants themselves — only `finding()` applies claim rewrite under `research_profile` / `vendor_claim`. Checker `observed_result` stays honest across all `test_basis` values.

## Claim matching

A profile `claimed_invariants` entry marks an invariant `declared` only if:

- the claimed id **exactly equals** the invariant id, or
- the claimed id is a parent (`AUTH-01` or `AUTH-03`) and the invariant is that id plus **one lowercase letter** (e.g. `AUTH-01` covers `AUTH-01a` / `AUTH-01b` / `AUTH-01c`).

No prefix matching and no case folding. `AUTH-08` is a known invariant (vendors may claim it) even though it has no checker yet. Claimed ids that are neither known invariants nor parents appear in report `unknown_claims`.

## Vocabulary

ControlLease, RuntimeGeneration, ActionBinding, ActionDigest, ApprovalDecision, FenceToken/FenceEpoch, EffectId, EffectReceipt.
