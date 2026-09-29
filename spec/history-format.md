# History JSONL format

Append-only probe history. Each non-empty, non-`#` line is one JSON object.

**`seq` is the log index.** It must be strictly monotonic (increasing, no duplicates) in file order. Parsers **must not** silently sort away out-of-order or duplicate `seq` — that hides probe bugs.

## Event kinds

| kind | Meaning |
| --- | --- |
| `invoke` | Operation started |
| `ok` | Success completion |
| `fail` | Guaranteed no effect |
| `info` | Uncertain / unknown (may have effect) |
| `observe` | Observation (e.g. `generation.observe`) |
| `fault` | Injected or observed fault |

**Critical:** `fail` ≠ `info`. A `fail` means the effect did not happen. An `info` means the outcome is unknown and may have side effects.

Unknown `kind` values are **rejected**.

## Top-level fields

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `seq` | number (finite) | **yes** | Strictly increasing across the file; duplicates and regressions are hard errors |
| `kind` | enum | **yes** | One of: `invoke`, `ok`, `fail`, `info`, `observe`, `fault` |
| `ts` | string (ISO-8601) | no | Wall-clock hint only; not causal order |
| `ts_unix_nano` | string (decimal digits) | no | Unix time in nanoseconds as a **decimal string** (not a JSON number). Matches `/^[0-9]+$/`. Any integer in history JSON that may exceed `2^53-1` MUST be a decimal string for the same reason: JS `JSON.parse` rounds large numbers past `Number.MAX_SAFE_INTEGER`, which can make integrity verifiers false-positive tamper. |
| `op` | string | no | Operation name when applicable |
| `fault` | string | no | Fault name when `kind=fault` (or annotating a fault injection) |
| `session_id` | string | no | Session this event belongs to |
| `actor_id` | string | no | Actor / controller / approver identity |
| `invoke_seq` | number | no | Links completion/observation back to an `invoke` seq |
| `attrs` | object | no | Checker-facing payload (see attrs keys below) |
| `note` | string | no | Human-readable annotation |

## Known ops (vocabulary)

| Op | Typical kinds |
| --- | --- |
| `lease.acquire` / `lease.renew` / `lease.release` / `lease.revoke` | `invoke`, `ok`, `fail`, `info` |
| `lease.observe` | `observe` — observational ownership (e.g. AHP turn ownership). **Not** a ControlLease; no checker treats it as lease acquire/renew/release. |
| `generation.observe` | `observe` |
| `action.propose` / `action.bind` | `invoke`, `ok`, `fail`, `info` |
| `approval.request` / `approval.grant` / `approval.deny` / `approval.record` | `invoke`, `ok`, `fail`, `info` |
| `effect.dispatch` / `effect.receipt` / `effect.query` / `effect.cancel` / `effect.reconcile` | `invoke`, `ok`, `fail`, `info` |
| `task.cancel` / `task.complete` / `task.timeout` / `task.reconcile` | `invoke`, `ok`, `fail`, `info` |
| `session.attach` / `session.detach` | `invoke`, `ok`, `fail`, `info` |
| `control.handoff` | `invoke`, `ok`, `fail`, `info` |

**Extension policy:** unknown `op` values are **allowed** (warn-or-allow). Parsers may emit a warning; they must not reject solely for an unknown op. Document new ops in adapters/findings when introduced.

## Known faults (vocabulary)

| Fault | Meaning |
| --- | --- |
| `runtime.restart` / `runtime.crash` | Process / runtime lifecycle |
| `state.restore` | Restored durable state |
| `net.partition` / `net.drop` / `net.delay` | Network faults |
| `client.disconnect` | Client dropped |
| `message.duplicate` | Replay / duplicate delivery |
| `clock.skew` | Clock anomaly |

**Extension policy:** unknown `fault` values are **allowed** with a warning (same as ops).

## `attrs` keys used by checkers

These keys appear under `attrs` and are consumed by checkers / vocabulary types. Not every event uses every key.

| Attr key | Type | Used by / meaning |
| --- | --- | --- |
| `runtime_generation` | number | AUTH-01; `RuntimeGeneration.value` |
| `issuer_id` | string | Generation issuer |
| `runtime_id` | string | Runtime identity; AUTH-01b stream key is `${runtime_id ?? ""}\|${session_id ?? ""}` (with `session_id`); also restart→observe mapping |
| `tool_call_id` | string | AUTH-07 subject after `subject_id` (before `session_id`) |
| `scope_id` | string | AUTH-03 lease / action scope |
| `holder` | string | Lease holder (`ControlLease.holder`) |
| `fence_epoch` | number | AUTH-03 / AUTH-04 / AUTH-05 fence (`FenceEpoch`) |
| `accepted` | boolean | Lease acquire acceptance |
| `action_type` | string | Action binding type |
| `target` | string | Action target |
| `action_digest` | string | AUTH-02 / AUTH-05 binding digest |
| `approver` | string | ApprovalDecision.approver |
| `decision` | `"grant"` \| `"deny"` | Approval outcome |
| `effect_id` | string | AUTH-06 / AUTH-07 effect identity |
| `task_id` | string | AUTH-07 terminal subject |
| `status` | string | Dispatch status |
| `outcome` | `"committed"` \| `"rejected"` \| `"failed"` \| `"unknown"` | EffectReceipt.outcome |
| `controller` | string | Acting controller at receipt |
| `boundary_id` | string | Effect boundary |
| `policy_version` | string | Binding policy version (AUTH-02) |
| `nonce` | string | Binding nonce (AUTH-02) |
| `expiry` | string | Binding / approval expiry (AUTH-02) |
| `stale_fence` / `stale_controller` | boolean | AUTH-04 markers |
| `terminal` / `resolved_terminal` | string | AUTH-07 terminal race |

## Validation rules (parser)

1. Skip blank lines and lines starting with `#`.
2. Each remaining line must be valid JSON **object**.
3. `seq` required, finite number.
4. `kind` required, must be in the kind enum (unknown kinds → **reject**).
5. If present: `op` / `fault` must be strings; unknown values → **warn, allow**.
6. If present: `invoke_seq` finite number; `attrs` object.
7. If present: `ts_unix_nano` must be a JSON **string** matching `/^[0-9]+$/` (reject JSON number, float, or scientific notation). Same rule for any other integer field that may exceed `2^53-1`.
8. After all lines: assert **strict seq monotonicity** (no sort, no dedupe).


### AUTH-07 `terminal_rules` values

Published profile `terminal_rules` values are limited to: `cancel_wins`, `complete_wins`, `timeout_wins`, `restart_wins`, `failed_wins`, `reconcile_required`.

Restart-class fault events may carry `attrs.runtime_id` for AUTH-01b observe mapping (unchanged: map by `runtime_id` match, else `session_id` match, else all). AUTH-01b generation-stream key is `${runtime_id ?? ""}|${session_id ?? ""}`: observes with neither share one empty stream; same `runtime_id` with different `session_id` are different streams.

## Example line

```json
{"seq":1,"ts":"2026-09-05T10:00:00Z","ts_unix_nano":"1757066400000000000","kind":"observe","op":"generation.observe","session_id":"s1","attrs":{"runtime_generation":1,"issuer_id":"lease_plane","runtime_id":"runtime_a"}}
```

Events without `ts_unix_nano` remain valid (backward compatible).

## Write helper

`serialize_history_jsonl(events)` / `write_history_file(path, events)` emit one JSON object per line. Writers should validate monotonic `seq` before writing.

When writing new events, prefer setting both `ts` (ISO-8601 wall-clock hint) and `ts_unix_nano` (decimal string). Core helper `format_unix_nano_decimal()` uses `BigInt(Date.now()) * 1_000_000n` — millisecond precision expanded to nanosecond units, not true OS nanosecond resolution.

## Checker output shape

Each finding keeps **two independent axes** (`claim_status` and `observed_result`). `result` is the **claim-rewritten grade** derived from those axes (plus `test_basis`).

| Field | Values | Meaning |
| --- | --- | --- |
| `invariant` | e.g. `AUTH-01b` | Which invariant |
| `claim_status` | `declared` \| `not_declared` \| `out_of_scope` \| `underspecified` | What the **profile** claims |
| `observed_result` | `supported` \| `not_declared` \| `violation` \| `inconclusive` \| `underspecified` \| `not_tested` | Checker's **raw** conclusion before claim rewrite |
| `result` | same labels | Claim-rewritten grade (may equal `observed_result`) |
| `witness_seqs` | number[] | Counterexample / support evidence seqs (unchanged by rewrite) |
| `explanation` | string | Human-readable reason (rewritten findings use a fixed prefix; see below) |
| `reproducible` | boolean | `false` when `observed_result` is `not_tested`; otherwise `true` (computed in `finding()`) |
| `test_basis` | `vendor_claim` \| `research_profile` \| `synthetic_fixture` | Evidence basis |

**`reproducible`:** Unexecuted findings (`observed_result === "not_tested"`, e.g. AUTH-08 stub) are **not** reproducible. All other findings are reproducible: they either point at evidence events via `witness_seqs`, or are explicitly profile-based (AUTH-01a; AUTH-01c when `generation_model` is G0) with empty `witness_seqs` and an explanation that says the conclusion is based on profile.

### Claim rewrite rules (`finding()`)

| `test_basis` | `claim_status` | `observed_result` | `result` |
| --- | --- | --- | --- |
| `synthetic_fixture` | `declared` or `not_declared` | any | = `observed_result` (no rewrite). Note: `not_tested` is never rewritten (any basis / claim_status). |
| `research_profile` or `vendor_claim` | `declared` | any | = `observed_result` |
| `research_profile` or `vendor_claim` | `not_declared` | `supported` or `violation` | `not_declared` (not graded; keep witnesses; explanation = `not graded: <invariant> is not in claimed_invariants (test_basis=<test_basis>). Observed <observed_result>: <original>`) |
| `research_profile` or `vendor_claim` | `not_declared` | `inconclusive` | `inconclusive` (evidence insufficiency — do not rewrite) |
| `research_profile` or `vendor_claim` | `not_declared` | `not_tested` | `not_tested` |
| any | `underspecified` | not `violation` | `underspecified` |
| any | `underspecified` | `violation` | `violation` |
| — | `out_of_scope` | — | nothing produces it today |


`not_tested` is never claim-rewritten (it stays `not_tested` regardless of `test_basis` / `claim_status`).

Undeclared invariants are **not graded**: both supported and violation rewrite to `not_declared` under research/vendor bases; the observed outcome stays in `observed_result` and the explanation.

Report also exposes:

- `capability_vector`: map invariant → **`result`** (claim-rewritten)
- `observed_vector`: map invariant → **`observed_result`**
- `claim_status_vector`: map invariant → **`claim_status`**
- `unknown_claims`: `claimed_invariants` ids that are neither in `KNOWN_INVARIANTS` nor `INVARIANT_PARENTS` (verbatim, including `""`)

### `not_tested` vs `not_declared` (must not conflate)

| | `result = not_tested` | `claim_status = not_declared` |
| --- | --- | --- |
| Meaning | Checker not implemented or not run | Profile does not claim the invariant |
| Source | Checker stub / runner | `AuthorityProfile.claimed_invariants` |
| Can co-occur? | **Yes** | |

Never treat `not_tested` as “the target doesn’t claim this.” Use `claim_status` for declaration, `observed_result` for raw measurement, and `result` for the claim-rewritten grade.

Top-level report fields: `target`, `profile_version`, `test_basis`, `findings`, `capability_vector`, `observed_vector`, `claim_status_vector`, `unknown_claims`.
