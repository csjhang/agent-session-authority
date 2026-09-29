# Glossary

| Term | Meaning |
| --- | --- |
| SessionId | Stable work-container id (not WebSocket, not LLM conversation) |
| ActorId | Human, client, service, or agent identity |
| ControlLease | scope, holder, issuedAt, expiresAt, fenceEpoch |
| RuntimeGeneration | Monotonic/reissued generation on authority-relevant runtime start/restore |
| ActionBinding | actionType, target, canonical args, policyVersion, runtimeGeneration, nonce, expiry |
| ActionDigest | Unambiguous digest of the four AUTH-02 action-defining fields (`action_type`, `target`, `args`, `policy_version`). Producers in this repo compute `"sha256:" + hex(sha256(UTF-8(JCS({action_type,target,args,policy_version}))))` via `packages/core/src/action_digest.ts` (JCS = RFC 8785 canonicalize). Missing `policy_version` is encoded as JSON `null`. Verifiers still treat the digest string as opaque equality. |
| ApprovalDecision | approver, actionDigest, decision, policy, issuedAt, expiresAt |
| FenceToken / FenceEpoch | Monotonic token effect gateway must verify |
| EffectId | Stable idempotency key for one intended effect |
| EffectReceipt | Verifiable reply from effect boundary |
| WorkSession | Long-lived shared work context |
| Observer / Contributor / Controller / Approver | Logical roles; ownership != control |


## EffectReceipt field map (three shapes)

One concept per row. Columns are field names in each shape, or "—" when absent.
Citations: history attrs — `spec/history-format.md` / ACP emitter `packages/adapters/acp/src/history_from_acp.ts`; sink — `packages/sink/src/types.ts` `EffectReceipt`; agent-effect — `spec/agent-effect-attributes.md` / `packages/sink/src/types.ts` `AgentEffectRecord`.

| Concept | history `effect.receipt` attrs | sink `EffectReceipt` | agent-effect `AgentEffectRecord` |
| --- | --- | --- | --- |
| effect id | `effect_id` (`spec/history-format.md:84`; ACP emit `history_from_acp.ts:434`) | `effectId` (`packages/sink/src/types.ts:7`) | `effect_id` (`spec/agent-effect-attributes.md:32`; `types.ts:126`) |
| action digest | `action_digest` (`history-format.md:81`; ACP `history_from_acp.ts:438`) | `actionDigest` (`types.ts:8`) | `action_digest` (`agent-effect-attributes.md:33`; `types.ts:127`) |
| runtime generation | `runtime_generation` (`history-format.md:72`; ACP `history_from_acp.ts:440`) | `runtimeGeneration` (`types.ts:9`) | `runtime_generation` (`agent-effect-attributes.md:38`; `types.ts:128`) |
| fence epoch | `fence_epoch` (`history-format.md:77`; ACP `history_from_acp.ts:441`) | `fenceEpoch` (`types.ts:10`) | `fence_epoch` (`agent-effect-attributes.md:39`; `types.ts:129`) |
| outcome | `outcome` (`history-format.md:87`; ACP `history_from_acp.ts:435`) | `outcome` (`types.ts:12`) | `outcome` (`agent-effect-attributes.md:41`; `types.ts:131`) |
| controller | `controller` (`history-format.md:88`) | `controller` (`types.ts:18`) | `controller` (`agent-effect-attributes.md:53`; `types.ts:137`) |
| scope | `scope_id` (`history-format.md:75`) | `scopeId` (`types.ts:20`) | `scope_id` (`agent-effect-attributes.md:54`; `types.ts:138`) |
| approval id | — (not a standard history attr today) | `approvalId` (`types.ts:22`) | `approval_id` (`agent-effect-attributes.md:35`; `types.ts:140`) |
| approval decision | `decision` on approval ops (`history-format.md:83`); not on receipt | `approvalDecision` (`types.ts:24`) | `approval_decision` (`agent-effect-attributes.md:34`; `types.ts:139`) |
| approval runtime generation | — | `approvalRuntimeGeneration` (`types.ts:26`) | `approval_runtime_generation` (`agent-effect-attributes.md:36`; `types.ts:141`) |
| boundary | `boundary_id` (`history-format.md:89`) | `boundaryId` (`types.ts:11`) | `boundary_id` (`agent-effect-attributes.md:40`; `types.ts:130`) |
| external reference | — | `externalReference` (`types.ts:13`) | `external_reference` (`agent-effect-attributes.md:42`; `types.ts:135`) |
| time | event `ts` / `ts_unix_nano` (`history-format.md:28–29`); receipt may also carry `observed_at` (ACP `history_from_acp.ts:444`) | `observedAt` (`types.ts:14`) | `ts` / `ts_unix_nano` (`agent-effect-attributes.md:45–46`; `types.ts:134,136`) |
| previous evidence hash | — | `previousEvidenceHash` (`types.ts:15`) | `previous_evidence_hash` (`agent-effect-attributes.md:66`; `types.ts:142`) |
| record kind | — | `recordKind` (`types.ts:31`) | `record_kind` (`agent-effect-attributes.md:57`; `types.ts:145`) |
| stream / sequence | history event `seq` (top-level, `history-format.md:26`) | — | `stream_id` + `sequence_number` (`agent-effect-attributes.md:43–44`; `types.ts:132–133`) |
| field_provenance | `field_provenance` (ACP-derived receipts, `history_from_acp.ts:450`) | — | — |
| binding | `binding` (`"linked"` or `"unlinked"`) when digest absent (ACP `history_from_acp.ts:438`) | — | — |

### Proposal only (no code in this PR)

Unify on a single TypeScript type for EffectReceipt / AgentEffectRecord, or add explicit conversion helpers (history attrs ↔ sink camelCase ↔ agent-effect snake_case). Until then, treat the table as the crosswalk; digests remain opaque string compare at verifiers.
