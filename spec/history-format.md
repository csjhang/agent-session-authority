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
| `runtime_id` | string | Runtime identity |
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
7. After all lines: assert **strict seq monotonicity** (no sort, no dedupe).

## Example line

```json
{"seq":1,"ts":"2026-09-05T10:00:00Z","kind":"observe","op":"generation.observe","session_id":"s1","attrs":{"runtime_generation":1,"issuer_id":"lease_plane","runtime_id":"runtime_a"}}
```

## Write helper

`serialize_history_jsonl(events)` / `write_history_file(path, events)` emit one JSON object per line. Writers should validate monotonic `seq` before writing.

## Checker output shape

Each finding keeps **two independent axes**:

| Field | Values | Meaning |
| --- | --- | --- |
| `invariant` | e.g. `AUTH-01b` | Which invariant |
| `claim_status` | `declared` \| `not_declared` \| `out_of_scope` \| `underspecified` | What the **profile** claims |
| `result` | `supported` \| `not_declared` \| `violation` \| `inconclusive` \| `underspecified` \| `not_tested` | What the **checker** concluded |
| `witness_seqs` | number[] | Counterexample / support evidence seqs |
| `explanation` | string | Human-readable reason |
| `reproducible` | boolean | Whether the finding is reproducible from the corpus |
| `test_basis` | `vendor_claim` \| `research_profile` \| `synthetic_fixture` | Evidence basis |

Report also exposes:

- `capability_vector`: map invariant → **`result`**
- `claim_status_vector`: map invariant → **`claim_status`**

### `not_tested` vs `not_declared` (must not conflate)

| | `result = not_tested` | `claim_status = not_declared` |
| --- | --- | --- |
| Meaning | Checker not implemented or not run | Profile does not claim the invariant |
| Source | Checker stub / runner | `AuthorityProfile.claimed_invariants` |
| Can co-occur? | **Yes** | |

Never treat `not_tested` as “the target doesn’t claim this.” Use `claim_status` for declaration and `result` for measurement.

Top-level report fields: `target`, `profile_version`, `test_basis`, `findings`, `capability_vector`, `claim_status_vector`.
