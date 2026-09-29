# Agent-effect attributes (draft / research profile)

**Status:** draft / research profile — **not** OpenTelemetry normative, **not** an OTEP MUST/SHOULD claim.
**Position:** format contract + offline verify (position 1). No hosted ledger.
**Scope:** authority fields an **effect boundary** should emit so a third party can ask: *what was allowed → what landed?*
**Non-scope:** custody / integrity of OTel audit log streams (hash-chain, collector signing, checkpoints). Consume those layers; do not rebuild them here.

Related: [`history-format.md`](history-format.md), [`glossary.md`](glossary.md), [`profile-v0.2.md`](profile-v0.2.md).
Vectors: [`vectors/agent-effect/`](vectors/agent-effect/).

---

## Why this exists

Generic `audit` semantic conventions cover actor / action / resource / result. They do **not** yet pin agent **authority** fields (action digest, approval binding, runtime generation, fence epoch, effect outcome, external reference).

`otel-agent-audit` proves *the log was not tampered with* from spans. It has **no** authority attributes. This draft owns the complementary gap: *the effect boundary’s receipt of who was allowed to do what, under which generation/fence, and what outcome landed*.

Community entry pattern observed in the OTel audit discussion: contributions come with **JCS (RFC 8785) pass/reject vectors** and an offline verifier. This tree follows that pattern **inside this repo only** — no posts to `open-telemetry/community`, apeirora PRs, or otel-agent-audit issues from this change.

---

## Object: `AgentEffectRecord`

One JSON object per effect-boundary emission (one intended effect attempt / receipt). Field names below are the **wire names** for this research profile (snake_case). A later OTel attribute mapping (e.g. `agent.effect.*`) is out of band and must not invent normative OTel levels here.

### Authority fields

| Field | Type | Level | Maps from | Meaning |
| --- | --- | --- | --- | --- |
| `schema_version` | string | **MUST** | — | Profile id; this draft uses `"asa.agent-effect/0.1"`. |
| `effect_id` | string | **MUST** | `EffectId` / `EffectReceipt.effect_id` | Stable idempotency key for one intended effect. |
| `action_digest` | string | **MUST** | `ActionDigest` / AUTH-02 / AUTH-05 | Unambiguous digest of the canonical `ActionBinding` that was (or was not) approved. |
| `approval_decision` | string enum | **SHOULD** | `ApprovalDecision.decision` | `"grant"` \| `"deny"` \| `"none"`. Use `"none"` when the boundary recorded no approval object (still emit the field when the producer knows that fact). |
| `approval_id` | string | **SHOULD** | approval binding | Opaque id tying this receipt to a stored approval / permission decision. Omit only when `approval_decision` is `"none"` and no id exists. |
| `approver` | string | **SHOULD** | `ApprovalDecision.approver` | Who granted/denied, when known. |
| `runtime_generation` | number (finite, ≥ 0) | **MUST** | `RuntimeGeneration` / AUTH-01 | Generation at the boundary when the effect was accepted or rejected. |
| `fence_epoch` | number (finite, ≥ 0) | **MUST** | `FenceEpoch` / AUTH-03–05 | Fence token epoch verified (or refused) at the gateway. |
| `boundary_id` | string | **MUST** | `EffectReceipt.boundary_id` | Which effect boundary emitted this record. |
| `outcome` | string enum | **MUST** | `EffectReceipt.outcome` / AUTH-06 | `"committed"` \| `"rejected"` \| `"failed"` \| `"unknown"`. **`unknown` is first-class** — crash / lost reply / truncated stream MUST NOT be rewritten as success. `fail` ≠ `info` in history JSONL; same honesty here. |
| `external_reference` | string \| null | **SHOULD** | `EffectReceipt.external_reference` | Pointer to an external system receipt (ticket id, FS path witness, API response id). Use JSON `null` when none. |
| `stream_id` | string | **MUST** | OTEP-style source stream | Id of the **source-assigned** stream owned by this boundary (or its AuditLogger). Different producers MUST NOT share a `stream_id`. |
| `sequence_number` | number (finite, ≥ 0) | **MUST** | OTEP-style `sequence.number` | Monotonic sequence **assigned by the producer** inside `stream_id`. Arrival order at a collector is **not** causal order. |
| `ts` | string (ISO-8601) | **SHOULD** | history `ts` | Wall-clock hint only; not causal order. |
| `ts_unix_nano` | string (decimal digits) | **MUST** (this profile) | history `ts_unix_nano` | Unix time in nanoseconds as a **decimal string** matching `/^[0-9]+$/`. **MUST NOT** be a JSON number (JS `JSON.parse` rounds above `2^53-1`). |

Optional but useful (warn-or-allow if present with wrong type):

| Field | Type | Level | Notes |
| --- | --- | --- | --- |
| `session_id` | string | **SHOULD** | Work-session container. |
| `controller` | string | **SHOULD** | Acting controller at the boundary. |
| `scope_id` | string | **SHOULD** | Lease / action scope. |
| `action_type` / `target` | string | **SHOULD** | Human-debug; digest remains authoritative. |
| `policy_version` | string | **MAY** | Binding policy version. |

### Integrity / envelope fields (not authority content)

These may appear on the **stored** record for custody layers (producer signature, collector co-sign, hash link). They are **not** agent-effect authority semantics.

| Field | Type | Notes |
| --- | --- | --- |
| `signature` | string | Producer (or other) signature over the **hashed form**. |
| `previous_evidence_hash` | string \| null | Optional local chain hint; not a substitute for OTel `audit.sequence.previous_hash`. |
| `integrity` | object | If used, prefer nested keys such as `integrity.value`, `integrity.canonicalization`, `integrity.signer`. |
| `integrity_value` / `integrity_canonicalization` / `integrity_signer` | string | Flat aliases some emitters may use. |

**Signer roles are not interchangeable.** If `integrity_signer` / `integrity.signer` is `"producer"`, a verifier MUST NOT treat a `"collector"` signature as satisfying a producer-signed claim (and the reverse). This draft does not define algorithms; it only forbids role confusion.

---

## Hashed form and JCS

**Canonicalization:** [RFC 8785 JSON Canonicalization Scheme (JCS)](https://www.rfc-editor.org/rfc/rfc8785).

**Hashed form** = JCS serialization of the record **after removing the exclusion set**.

### Exclusion set (MUST strip before hash / before comparing claimed JCS)

Inspired by OTEP audit case C (integrity fields must not sit inside the bytes being chained/signed):

- `signature`
- `previous_evidence_hash`
- `integrity` (entire object)
- `integrity_value`
- `integrity_canonicalization`
- `integrity_signer`
- any key matching `/^integrity(\.|_)/` (prefix guard for extensions)

Witness data must not appear inside the bytes being witnessed. If a collector later co-signs, producer `previous_*` links stay stable only when integrity keys stay out of the hashed form.

### Validation rules (offline verifier)

1. Parse as a JSON **object**.
2. `schema_version` MUST equal `"asa.agent-effect/0.1"` for this vector suite (other values → reject as unsupported profile, not as “invalid JSON”).
3. Every **MUST** authority field above MUST be present with the declared type.
4. `outcome` MUST be one of the four enum values (including `"unknown"`).
5. `ts_unix_nano` MUST be a JSON **string** matching `/^[0-9]+$/` — reject JSON number, float string, or scientific notation.
6. `runtime_generation` and `fence_epoch` MUST be finite JSON numbers ≥ 0 (these stay numbers; only integers that may exceed `2^53-1` use decimal strings).
7. Build hashed form by deep-cloning the object and deleting exclusion-set keys at the **top level**.
8. Hashed form MUST NOT contain any exclusion-set key (reject `integrity_in_hashed_form` if a provided `hashed_form` object still includes them).
9. JCS(hashed form) MUST be stable cross-implementation; vectors pin expected JCS UTF-8 bytes (as hex of SHA-256, and/or the exact JCS string for small fixtures).

---

## Example (pass shape)

```json
{
  "schema_version": "asa.agent-effect/0.1",
  "effect_id": "eff-1",
  "action_digest": "sha256:deadbeef",
  "approval_decision": "grant",
  "approval_id": "appr-9",
  "approver": "human:alice",
  "runtime_generation": 2,
  "fence_epoch": 7,
  "boundary_id": "fs-gateway",
  "outcome": "committed",
  "external_reference": "file:///tmp/witness.txt",
  "stream_id": "boundary/fs-gateway",
  "sequence_number": 1,
  "ts": "2026-09-29T01:00:00.000Z",
  "ts_unix_nano": "1759107600000000000",
  "session_id": "s1",
  "controller": "runtime_a",
  "signature": "BASE64_NOT_IN_HASH"
}
```

After exclusion, `signature` is gone; JCS is taken over the remaining object (keys sorted per RFC 8785).

---

## What this is not

- Not an OTel semantic convention proposal text for upstream merge.
- Not a hash-chain / checkpoint / key-rotation protocol (use signingprocessor / OTEP audit integrity work).
- Not a hosted audit store.
- Not a claim that `otel-agent-audit` is wrong — it solves custody; this draft solves authority at the effect boundary.

---

## Cross-record authority checks

Offline verifier: [`vectors/agent-effect/cross-verify.ts`](vectors/agent-effect/cross-verify.ts) (`verifyCrossRecords`).
Fixtures: `cross-pass-*` / `cross-reject-*` / `cross-report-*` under [`vectors/agent-effect/`](vectors/agent-effect/).

Given a **set** of `AgentEffectRecord` objects (JSONL lines or a JSON array), the verifier checks mutual authority consistency:

1. **Committed needs approval** — every record with `outcome=committed` must have a corresponding prior approval: some record with the same `effect_id`, `approval_decision=grant`, and a non-empty `approval_id` (same record counts).
2. **Action digest consistency** — all records sharing an `effect_id` must carry the same `action_digest`; the approval-bound digest must equal the committed effect’s digest.
3. **Generation binding** — the approval’s `runtime_generation` must equal the landing effect’s `runtime_generation`. Reusing an approval across generations is an error (`cross_generation_reuse`).
4. **Fence monotonicity** — within one `stream_id`, `fence_epoch` must not go backwards when ordered by `sequence_number`. A committed effect’s `fence_epoch` must not be lower than its approval’s `fence_epoch`.
5. **Unauthorized effect** — a committed effect with no prior approval is reported as `unauthorized_effect` (the hard failure for rule 1).
6. **Unknown is first-class** — `outcome=unknown` is listed in a separate `unknowns` report. It is **not** treated as committed (does not require approval) and **not** treated as failed.
7. **Sequence integrity** — within one `stream_id`, a duplicate `sequence_number` is a hard violation (`duplicate_sequence`). Missing numbers between the observed min and max are reported as `sequence_gap` soft reports (they do **not** flip `ok` to false).

### Boundary (what this does *not* prove)

- The verifier only proves that the **records are mutually consistent** with these rules.
- It does **not** prove that any external side effect really happened (FS write, API call, ticket, …).
- It does **not** verify signatures, hash chains, checkpoints, or key rotation — those belong to the signingprocessor / OTEP custody layer. Integrity keys remain excluded from the single-record hashed form; this cross-record pass does not add them.

### Placement note

These checks live next to the agent-effect draft vectors (`spec/vectors/agent-effect/`), not in `packages/core` AUTH-01…07. Core checkers evaluate fault-probe `HistoryEvent` histories; they do not consume `asa.agent-effect/0.1` JSONL. See the vectors README for the conceptual overlap map.

## Vectors

See [`vectors/agent-effect/`](vectors/agent-effect/) for pass/reject fixtures and the offline verifier.
