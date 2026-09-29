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
| `approval_runtime_generation` | number (finite, ≥ 0) | **SHOULD** | approval issuance generation | Generation **when the referenced approval was issued**. Distinct from `runtime_generation` (generation at the effect boundary for this record). When present, cross-record generation binding uses this value; when absent, the verifier uses a separate issuance record if one exists, otherwise soft-reports `approval_generation_unverifiable`. |
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
| `record_kind` | string enum | **MAY** | `"effect"` (default when omitted) \| `"approval"`. Sink `grant()` issuance emits `"approval"`; accept/reject receipts always emit `"effect"`. Cross-verify: `record_kind="effect"` MUST NOT be treated as approval by `isApprovalRecord` even if approval fields are present; legacy issuance only when `record_kind` is absent. |

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

**Record hash vs chain hash (mock sink / local ledger):**

- **Record hash** = `sha256(JCS(hashed form))`. Link fields (`previous_evidence_hash`, `signature`, `integrity*`) are excluded so key-order and co-sign envelopes do not change the record hash.
- **Chain hash** = `sha256(previous_chain_hash_bytes || record_hash_bytes)` over UTF-8 of the hex strings, where the first record’s previous is the **empty string**. The receipt’s `previous_evidence_hash` stores the prior record’s **chain hash** (not its record hash); `lastEvidenceHash` is the latest chain hash.
- `verify_chain(ledger, expectedHead?)` recomputes from the start and reports the first broken link (pointer mismatch). When `expectedHead` is supplied, the final chain hash must equal it or the result is `ok=false` with reason `head_mismatch`.
- **Unkeyed chain limitation:** a full rewrite that recomputes every `previous_evidence_hash` pointer will still verify as `ok=true` when no `expectedHead` is supplied. Detecting a full rewrite needs a head anchored **outside** the ledger (signature, public checkpoint, or sink-known snapshot set). This mock has **no signatures**; the mock sink under `enforce` rejects restore of snapshots it did not produce — integrity is `sha256(JCS(full snapshot))` covering ledger, holders, fence/generation, and other snap fields (`unknown_snapshot`) — and always checks chain+head on restore (`chain_invalid`). Under `enforce`, restore also **must not rewind fencing**: `runtimeGeneration`/`fenceEpoch` become `max(current, snap)+1` and holders stay at the pre-restore values (`sink.restore_bump`), matching AUTH-01b.

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

Given a **set** of `AgentEffectRecord` objects (JSONL lines or a JSON array), the verifier checks mutual authority consistency.

**Indexing:** approvals are keyed by `approval_id`, not by `effect_id`. A committed effect's referenced `approval_id` must resolve to an **issuance** (a prior `approval_decision=grant` for that id that is an approval record — `record_kind=approval`, or legacy non-committed decision without `record_kind` — never `record_kind=effect`). Self-declared approval fields on a committed / effect-kind record are only a **claim** of use, not independent issuance evidence for generation binding — including when another effect's committed record self-declares the same `approval_id`.

1. **Committed needs approval** — every `outcome=committed` must resolve to a prior **issuance** grant for its `approval_id` (`approval_decision=grant` + non-empty `approval_id`, and **not** `record_kind=effect`). If the commit omits approval fields, the verifier may recover an `approval_id` only from prior grant/deny **issuance** decisions on the **same** `effect_id` (so commit-after-revoke is visible). Committed records' approval fields only **claim which `approval_id` was used** — they are never treated as independent issuance. `record_kind=effect` never counts as approval/issuance on any approval-finding path (`resolveApprovalId`, decisions lists, `separateGrants`, `resolveIssuanceGeneration`, `pickLatest` candidates). Otherwise → `unauthorized_effect`.
2. **Action digest consistency** — among **committed effects** and **approval records** (`record_kind=approval`, or legacy non-committed decision issuances without `record_kind`) sharing an `effect_id`, digests must match; the approval-bound digest must equal the committed effect's digest. A `rejected`/`failed` record with a different digest is a soft report `rejected_digest_variant` (does **not** flip `ok`) — the honest "sink rejected digest reuse" case.
3. **Generation binding** — the approval's **issuance generation** must equal the landing effect's `runtime_generation`. Issuance generation is taken from `approval_runtime_generation` when present on the committed claim; otherwise from a **separate** issuance record's `approval_runtime_generation` or `runtime_generation`. Issuance candidates exclude `record_kind=effect` (effect receipts that echo approval fields are claims of use, not issuance). Reusing an approval across generations → `cross_generation_reuse`. If neither `approval_runtime_generation` nor a separate issuance record exists → soft report `approval_generation_unverifiable` (does **not** fail `ok`). Same-record self-declaration alone is not enough to decide generation.
4. **Fence monotonicity** —
   - **4a (stream):** within one `stream_id`, `fence_epoch` must not go backwards when ordered by `sequence_number`, counting **only committed + approval** records. A `rejected`/`failed` (non-approval) record with a lower `fence_epoch` than the prior hard fence → soft report `rejected_stale_fence` (does **not** flip `ok`).
   - **4b (binding):** a committed effect's `fence_epoch` must not be lower than its approval issuance's `fence_epoch` → hard `effect_fence_before_approval`.
5. **Unauthorized / revoked / reuse / duplicate commit** —
   - no resolvable prior **issuance** grant (`record_kind=effect` never counts) → `unauthorized_effect`;
   - **latest prior issuance decision wins** for the same `approval_id` (not earliest; effect-kind records excluded): if the latest decision before the effect is `deny`, a subsequent commit → `revoked_approval_used`;
   - same `approval_id` used by multiple different `effect_id`s among committed records → `approval_reused_across_effects` (committed approval fields are the use claim);
   - more than one `outcome=committed` for the same `effect_id` → `duplicate_commit`.

6. **Unknown is first-class** — `outcome=unknown` with `record_kind` absent or `"effect"` is listed in a separate `unknowns` report. Records with `record_kind=approval` are **not** listed there (they are issuance, not stranded effects). Unknown is **not** treated as committed (does not require approval) and **not** treated as failed.
7. **Sequence integrity** — within one `stream_id`, a duplicate `sequence_number` is a hard violation (`duplicate_sequence`). Gaps are detected by **adjacent differences** only (sort unique sequence numbers; report when `next - prev > 1`). The verifier does **not** walk every integer from the observed min to max (large jumps would hang or exhaust memory). Each gap is a soft `sequence_gap` report (does **not** flip `ok` to false). When the gap span is small, `missing` may list the absent numbers; for huge spans only `from`/`to` are reliable.

### Ordering limitation (cross-stream)

Within one `stream_id`, prior/later decisions use `sequence_number`. Across different streams, the offline verifier falls back to comparing `ts_unix_nano`. That is a **reference clock only**: the field table already says `ts` / wall-clock hints are **not** causal order. Cross-stream “prior” checks based on timestamps therefore carry the same limitation — they are a practical tie-break for offline fixtures, not a happened-before proof across producers.

### Boundary (what this does *not* prove)

- The verifier only proves that the **records are mutually consistent** with these rules.
- It does **not** prove that any external side effect really happened (FS write, API call, ticket, …).
- It does **not** verify signatures, hash chains, checkpoints, or key rotation — those belong to the signingprocessor / OTEP custody layer. Integrity keys remain excluded from the single-record hashed form; this cross-record pass does not add them.
- Cross-stream ordering via `ts_unix_nano` does **not** prove causal order (see Ordering limitation above).

### Placement note

These checks live next to the agent-effect draft vectors (`spec/vectors/agent-effect/`), not in `packages/core` AUTH-01…07. Core checkers evaluate fault-probe `HistoryEvent` histories; they do not consume `asa.agent-effect/0.1` JSONL. See the vectors README for the conceptual overlap map.

## Vectors

See [`vectors/agent-effect/`](vectors/agent-effect/) for pass/reject fixtures and the offline verifier.
