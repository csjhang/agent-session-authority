# corpus/auth08

Flat AUTH-08 fixtures. Co-locate `<case>.jsonl` + `<case>.assessment.json` + optional `<case>.disclosures.json` (and optional `<case>.profile.json`).

| File | Maps to | AUTH-08 `observed_result` |
| --- | --- | --- |
| `not-tested-empty` | NT_EMPTY | `not_tested` |
| `not-tested-no-ep` | E1 / must-fix 2 | `not_tested` |
| `inconclusive-disclosure-only` | E2 | `inconclusive` |
| `pass-supported-disclosed` | E3 | `supported` |
| `violate-e2e-claim` | E4 | `violation` |
| `pass-never-asked-disclosed` / `violate-undisclosed` | E5 | `supported` / `violation` |
| `e6-deny-then-write` | E6 (non-`pass-*`; AUTH-02 `committed_after_deny`) | AUTH-08 `supported` |
| `pass-executed-no-bypass` | §二 g SUP_NO_BYPASS | `supported` |
| `pass-no-enforcement-point-seen-attr` | E7 | `supported` |
| `inconclusive-verification-not-found` | E8 | `inconclusive` |
| `pass-client-fs-disclosed` / `violate-client-fs-undisclosed` | E9 | `supported` / `violation` |
| `pass-probe-mode-disclosed` | E10 | `supported` |
| `pass-research-undeclared` | E11 | `observed_result=supported`, `result=not_declared` |
| `pass-settings-allowlist-disclosed` / `violate-settings-allowlist-undisclosed` | E12 | `supported` / `violation` |
| `pass-allow-always-standing` | §二 b | `supported` (standing note) |
| `inconclusive-allow-always-cross-gen` | must-fix 4 | `inconclusive` |
| `inconclusive-allow-always-unscoped` | must-fix 4 | `inconclusive` |
| `inconclusive-unmapped-receipt` | §二 a | `inconclusive` |
| `pass-replay-ignored` | §二 a | `supported` |
| `inconclusive-missing-path-id` | §二 f | `inconclusive` |
| `inconclusive-no-disclosures-loaded` | §二 e | `inconclusive` |
| `inconclusive-idle-attempts` | §二 g | `inconclusive` |
| `violate-multi-mix` | §二 h | `violation` |
| `inconclusive-e2e-not-found` | must-fix 5 step 3 | `inconclusive` |
| `inconclusive-request-after-effect` | override A3 | `inconclusive` |
| `inconclusive-ambiguous-path` | must-fix 6 | `inconclusive` |
| `violate-case-mismatch` | §二 c | `violation` |

| `violate-path-only-receipt-undisclosed` / `pass-path-only-receipt-disclosed` | must-fix 1 PR-11d | `violation` / `supported` |
| `inconclusive-allow-always-gen-unknown` | must-fix 2 | `inconclusive` |
| `violate-allow-always-different-type-cross-gen` | must-fix 3 | `violation` |
| `inconclusive-forbidden-probe-attr` | must-fix 4 | `inconclusive` |
| `pass-path-asked-via-bind` / `violate-path-asked-bind-diff-gen` / `violate-path-asked-bind-diff-session` | override B | `supported` / `violation` / `violation` |
| `inconclusive-replay-receipt-no-request` / `violate-replay-request-not-ask` | replay ignore | `inconclusive` / `violation` |
| `violate-multi-mix-inconclusive` | §二 h +inconclusive | `violation` |
| `violate-allow-once-not-standing` | option_kind | `violation` |
| `violate-receipt-bypass-id-unlinked` | receipt path_id unlinked | `violation` |
| `inconclusive-bypass-path-id-mismatch` | must-fix 6 | `inconclusive` |

Expectations live in `packages/core/test/auth08-corpus.test.ts` (explicit table; do not infer from filename alone).
