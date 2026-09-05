# Session Authority Profile v0.2

Fault Probe test basis (2026-09-05). Measures coverage; not a normative industry standard.

## Problem

Across people, devices, runtimes, and restarts: who may act now, who approved what, which action is still valid, and which effect actually happened.

## Invariants (first wave)

| ID | Rule |
| --- | --- |
| AUTH-01a | Declare generation model G0/G1/G2 |
| AUTH-01b | RuntimeGeneration strictly increases across crash, restart, restore-from-backup |
| AUTH-01c | G1+ issuer != fenced object |
| AUTH-03a | Scope determinism: publish (actionType,target)->scopeId; no conflicting self-declare |
| AUTH-03b | <=1 valid ControlLease per (scopeId, fenceEpoch) |
| AUTH-03c | Gateway rejects ActionBinding.scopeId outside holder lease |
| AUTH-05 | Approval is not control; control is not blanket approval |
| AUTH-06 | No implicit success without trusted EffectReceipt; fail!=info |

AUTH-02/04/07 are stubbed `not_tested` in week 1.

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
