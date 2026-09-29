/**
 * Offline cross-record authority checks for asa.agent-effect/0.1 JSONL sets.
 *
 * Proves mutual consistency among AgentEffectRecord emissions.
 * Does NOT prove external effects happened; does NOT verify signatures or hash chains.
 *
 * Approvals are indexed by approval_id (not effect_id). Self-declared approval
 * fields on a committed record are a claim, not independent issuance evidence.
 * Independent issuance = record_kind=approval, or legacy (absent record_kind)
 * non-committed decision+id. outcome=committed never counts as a decision candidate.
 */
import { verifyAgentEffectRecord } from "./profile.js";
import { canonicalize } from "./jcs.js";

export type CrossViolationCode =
  | "unauthorized_effect"
  | "inconsistent_action_digest"
  | "approval_digest_mismatch"
  | "cross_generation_reuse"
  | "fence_epoch_regression"
  | "effect_fence_before_approval"
  | "duplicate_sequence"
  | "duplicate_commit"
  | "revoked_approval_used"
  | "approval_reused_across_effects"
  | "committed_after_deny"
  | "approval_effect_mismatch"
  | "invalid_record";

export type CrossReportCode =
  | "approval_generation_unverifiable"
  | "rejected_digest_variant"
  | "rejected_stale_fence"
  | "stream_ts_regression"
  | "ambiguous_decision_order";

export interface CrossViolation {
  code: CrossViolationCode;
  message: string;
  effect_id?: string;
  stream_id?: string;
  approval_id?: string;
  indices?: number[];
}

export interface CrossGapReport {
  code: "sequence_gap";
  stream_id: string;
  missing: number[];
  from: number;
  to: number;
}

export interface CrossUnknownReport {
  effect_id: string;
  stream_id: string;
  sequence_number: number;
  index: number;
}

export interface CrossSoftReport {
  code: CrossReportCode;
  message: string;
  effect_id?: string;
  approval_id?: string;
  indices?: number[];
}

export interface CrossVerifyResult {
  /** False when any hard violation is present. Soft reports / gaps alone do not fail. */
  ok: boolean;
  violations: CrossViolation[];
  gaps: CrossGapReport[];
  unknowns: CrossUnknownReport[];
  /** Soft authority reports (do not flip ok). */
  reports: CrossSoftReport[];
}

export interface CrossVerifyOptions {
  /** When true, committed effects require independent issuance (no claim-only). */
  requireIssuance?: boolean;
}

export interface AgentEffectFields {
  effect_id: string;
  action_digest: string;
  runtime_generation: number;
  fence_epoch: number;
  outcome: string;
  stream_id: string;
  sequence_number: number;
  ts_unix_nano: string;
  approval_decision?: string;
  approval_id?: string;
  /** Generation when the referenced approval was issued (SHOULD). */
  approval_runtime_generation?: number;
  /** Optional; default "effect". Sink grant() emits "approval". */
  record_kind?: "effect" | "approval";
}

interface IndexedRecord {
  index: number;
  fields: AgentEffectFields;
  /** Monotonic-max logical clock within stream (BigInt decimal string). */
  order_ts: bigint;
  /** JCS of raw record for deterministic global tie-break. */
  jcs: string;
  raw: Record<string, unknown>;
}

function asFields(raw: Record<string, unknown>): AgentEffectFields {
  return {
    effect_id: raw.effect_id as string,
    action_digest: raw.action_digest as string,
    runtime_generation: raw.runtime_generation as number,
    fence_epoch: raw.fence_epoch as number,
    outcome: raw.outcome as string,
    stream_id: raw.stream_id as string,
    sequence_number: raw.sequence_number as number,
    ts_unix_nano: raw.ts_unix_nano as string,
    approval_decision:
      typeof raw.approval_decision === "string" ? raw.approval_decision : undefined,
    approval_id: typeof raw.approval_id === "string" ? raw.approval_id : undefined,
    approval_runtime_generation:
      typeof raw.approval_runtime_generation === "number" &&
      Number.isFinite(raw.approval_runtime_generation)
        ? (raw.approval_runtime_generation as number)
        : undefined,
    record_kind:
      raw.record_kind === "approval" || raw.record_kind === "effect"
        ? raw.record_kind
        : undefined,
  };
}

function hasApprovalId(f: AgentEffectFields): boolean {
  return typeof f.approval_id === "string" && f.approval_id.length > 0;
}

/**
 * Independent issuance only: approval records, or legacy non-committed decision+id.
 * outcome=committed and record_kind=effect never count as decision/issuance.
 */
function isIndependentDecision(f: AgentEffectFields): boolean {
  if (f.outcome === "committed") return false;
  if (f.record_kind === "effect") return false;
  if (!(f.approval_decision === "grant" || f.approval_decision === "deny")) return false;
  if (!hasApprovalId(f)) return false;
  if (f.record_kind === "approval") return true;
  // legacy (absent record_kind): non-committed decision+id
  return f.record_kind === undefined;
}

function isGrant(f: AgentEffectFields): boolean {
  return isIndependentDecision(f) && f.approval_decision === "grant";
}

function isDeny(f: AgentEffectFields): boolean {
  return isIndependentDecision(f) && f.approval_decision === "deny";
}

/**
 * Explicit approval records, or legacy issuance (decision + non-committed, no record_kind).
 */
function isApprovalRecord(f: AgentEffectFields): boolean {
  if (f.record_kind === "approval") return true;
  if (f.record_kind === "effect") return false;
  return isIndependentDecision(f);
}

/**
 * Unknowns list only outcome=unknown records that are not approval records.
 * isApprovalRecord covers record_kind=approval and legacy non-committed decision+id.
 */
function isEffectKindForUnknowns(f: AgentEffectFields): boolean {
  return !isApprovalRecord(f);
}

function parseTs(ts: string): bigint {
  try {
    return BigInt(ts);
  } catch {
    return 0n;
  }
}

/** Global ascending: order_ts, stream_id, sequence_number, JCS. */
function compareGlobal(a: IndexedRecord, b: IndexedRecord): number {
  if (a.order_ts < b.order_ts) return -1;
  if (a.order_ts > b.order_ts) return 1;
  if (a.fields.stream_id < b.fields.stream_id) return -1;
  if (a.fields.stream_id > b.fields.stream_id) return 1;
  if (a.fields.sequence_number !== b.fields.sequence_number) {
    return a.fields.sequence_number - b.fields.sequence_number;
  }
  if (a.jcs < b.jcs) return -1;
  if (a.jcs > b.jcs) return 1;
  return a.index - b.index;
}

/**
 * Whether `a` is prior-or-same relative to commit `c`.
 * Same stream: sequence_number ≤. Different streams: order_ts only (equal = prior).
 * Does NOT use stream_id / sequence_number / JCS for cross-stream priorness —
 * those belong only to pickLatest among candidates already known to be prior.
 */
function isPriorOrSame(a: IndexedRecord, c: IndexedRecord): boolean {
  if (a.index === c.index) return true;
  if (a.fields.stream_id === c.fields.stream_id) {
    return a.fields.sequence_number <= c.fields.sequence_number;
  }
  return a.order_ts <= c.order_ts;
}

/**
 * Latest among prior candidates. Fail-closed only when stream-heads at max
 * order_ts disagree (both grant and deny). Per stream, every record that
 * shares the largest sequence_number at that order_ts is a head — so a
 * same-stream duplicate_sequence grant+deny tie participates in conflict.
 * Superseded (lower sequence_number) same-stream decisions do not.
 * Global sort (order_ts, stream_id, sequence_number, JCS) picks the latest
 * among heads already known to be prior — not for deciding priorness.
 */
function pickLatest(
  recs: IndexedRecord[],
): { latest: IndexedRecord | undefined; ambiguous: boolean } {
  if (recs.length === 0) return { latest: undefined, ambiguous: false };
  let maxTs = recs[0]!.order_ts;
  for (const r of recs) {
    if (r.order_ts > maxTs) maxTs = r.order_ts;
  }
  const atMax = recs.filter((r) => r.order_ts === maxTs);
  // Per-stream heads: ALL records sharing the max sequence_number at max order_ts.
  const maxSeqByStream = new Map<string, number>();
  for (const r of atMax) {
    const cur = maxSeqByStream.get(r.fields.stream_id);
    if (cur === undefined || r.fields.sequence_number > cur) {
      maxSeqByStream.set(r.fields.stream_id, r.fields.sequence_number);
    }
  }
  const heads = atMax.filter(
    (r) => r.fields.sequence_number === maxSeqByStream.get(r.fields.stream_id),
  );
  const hasGrant = heads.some((r) => isGrant(r.fields));
  const hasDeny = heads.some((r) => isDeny(r.fields));
  if (hasGrant && hasDeny) {
    const deny = heads.filter((r) => isDeny(r.fields)).sort(compareGlobal).pop()!;
    return { latest: deny, ambiguous: true };
  }
  const sorted = [...heads].sort(compareGlobal);
  return { latest: sorted[sorted.length - 1], ambiguous: false };
}

/**
 * Resolve which approval_id a committed effect claims.
 * Prefer the record's own approval_id; else latest prior independent decision on same effect_id.
 */
function resolveApprovalId(
  committed: IndexedRecord,
  indexed: IndexedRecord[],
): string | undefined {
  if (hasApprovalId(committed.fields)) {
    return committed.fields.approval_id;
  }
  const priorOnEffect = indexed.filter(
    (r) =>
      r.index !== committed.index &&
      r.fields.effect_id === committed.fields.effect_id &&
      isIndependentDecision(r.fields) &&
      isPriorOrSame(r, committed),
  );
  const { latest } = pickLatest(priorOnEffect);
  return latest?.fields.approval_id;
}

function issuanceGeneration(issuance: IndexedRecord): number {
  return typeof issuance.fields.approval_runtime_generation === "number"
    ? issuance.fields.approval_runtime_generation
    : issuance.fields.runtime_generation;
}

/**
 * Verify a set of AgentEffectRecord objects (JSONL lines parsed to objects).
 */
export function verifyCrossRecords(
  rawRecords: unknown[],
  options: CrossVerifyOptions = {},
): CrossVerifyResult {
  const requireIssuance = options.requireIssuance === true;
  const violations: CrossViolation[] = [];
  const gaps: CrossGapReport[] = [];
  const unknowns: CrossUnknownReport[] = [];
  const reports: CrossSoftReport[] = [];
  const indexed: IndexedRecord[] = [];

  for (let i = 0; i < rawRecords.length; i++) {
    const raw = rawRecords[i];
    const single = verifyAgentEffectRecord(raw);
    if (!single.ok) {
      violations.push({
        code: "invalid_record",
        message: `record[${i}]: ${single.code}: ${single.message}`,
        indices: [i],
      });
      continue;
    }
    const obj = raw as Record<string, unknown>;
    const fields = asFields(obj);
    let jcs: string;
    try {
      jcs = canonicalize(obj);
    } catch {
      jcs = JSON.stringify(obj);
    }
    indexed.push({
      index: i,
      fields,
      order_ts: 0n, // filled below
      jcs,
      raw: obj,
    });

    if (fields.outcome === "unknown" && isEffectKindForUnknowns(fields)) {
      unknowns.push({
        effect_id: fields.effect_id,
        stream_id: fields.stream_id,
        sequence_number: fields.sequence_number,
        index: i,
      });
    }
  }

  if (violations.some((v) => v.code === "invalid_record")) {
    return { ok: false, violations, gaps, unknowns, reports };
  }

  // Assign order_ts: per-stream monotonic max of ts_unix_nano by sequence_number.
  const byStreamAssign = new Map<string, IndexedRecord[]>();
  for (const rec of indexed) {
    const list = byStreamAssign.get(rec.fields.stream_id) ?? [];
    list.push(rec);
    byStreamAssign.set(rec.fields.stream_id, list);
  }
  for (const [streamId, group] of byStreamAssign) {
    const ordered = [...group].sort((a, b) => {
      if (a.fields.sequence_number !== b.fields.sequence_number) {
        return a.fields.sequence_number - b.fields.sequence_number;
      }
      return a.index - b.index;
    });
    let maxTs = 0n;
    let haveMax = false;
    for (const rec of ordered) {
      const rawTs = parseTs(rec.fields.ts_unix_nano);
      if (haveMax && rawTs < maxTs) {
        reports.push({
          code: "stream_ts_regression",
          message: `stream_id=${streamId}: ts_unix_nano regresses at sequence_number=${rec.fields.sequence_number}`,
          effect_id: rec.fields.effect_id,
          indices: [rec.index],
        });
      }
      // monotonic max
      const order = haveMax ? (rawTs > maxTs ? rawTs : maxTs) : rawTs;
      rec.order_ts = order;
      maxTs = order;
      haveMax = true;
    }
  }

  // Group by effect_id for digest consistency + duplicate commits.
  const byEffect = new Map<string, IndexedRecord[]>();
  for (const rec of indexed) {
    const list = byEffect.get(rec.fields.effect_id) ?? [];
    list.push(rec);
    byEffect.set(rec.fields.effect_id, list);
  }

  for (const [effectId, group] of byEffect) {
    const hard = group.filter(
      (r) => r.fields.outcome === "committed" || isApprovalRecord(r.fields),
    );
    const hardDigests = new Set(hard.map((r) => r.fields.action_digest));
    if (hardDigests.size > 1) {
      violations.push({
        code: "inconsistent_action_digest",
        message: `effect_id=${effectId} has multiple action_digest values among committed/approval: ${[...hardDigests].join(", ")}`,
        effect_id: effectId,
        indices: hard.map((r) => r.index),
      });
    }

    const soft = group.filter(
      (r) => r.fields.outcome === "rejected" || r.fields.outcome === "failed",
    );
    if (hardDigests.size >= 1 && soft.length > 0) {
      const canonical = [...hardDigests][0]!;
      const variants = soft.filter((r) => r.fields.action_digest !== canonical);
      if (variants.length > 0) {
        reports.push({
          code: "rejected_digest_variant",
          message: `effect_id=${effectId}: rejected/failed record(s) carry action_digest different from committed/approval digest ${canonical}`,
          effect_id: effectId,
          indices: variants.map((r) => r.index),
        });
      }
    }

    const committed = group.filter((r) => r.fields.outcome === "committed");
    if (committed.length > 1) {
      violations.push({
        code: "duplicate_commit",
        message: `effect_id=${effectId} has ${committed.length} outcome=committed records`,
        effect_id: effectId,
        indices: committed.map((r) => r.index),
      });
    }
  }

  // approval_reused_across_effects
  const committedByApproval = new Map<string, IndexedRecord[]>();
  for (const rec of indexed) {
    if (rec.fields.outcome !== "committed" || !hasApprovalId(rec.fields)) continue;
    const aid = rec.fields.approval_id!;
    const list = committedByApproval.get(aid) ?? [];
    list.push(rec);
    committedByApproval.set(aid, list);
  }
  for (const [approvalId, commits] of committedByApproval) {
    const effectIds = new Set(commits.map((c) => c.fields.effect_id));
    if (effectIds.size > 1) {
      violations.push({
        code: "approval_reused_across_effects",
        message: `approval_id=${approvalId} used by multiple committed effect_ids: ${[...effectIds].join(", ")}`,
        approval_id: approvalId,
        indices: commits.map((c) => c.index),
      });
    }
  }

  const committedAll = indexed.filter((r) => r.fields.outcome === "committed");
  for (const c of committedAll) {
    const approvalId = resolveApprovalId(c, indexed);
    if (!approvalId) {
      violations.push({
        code: "unauthorized_effect",
        message: `committed effect_id=${c.fields.effect_id} has no prior approval (approval_decision=grant with approval_id)`,
        effect_id: c.fields.effect_id,
        indices: [c.index],
      });
      continue;
    }

    const decisions = indexed.filter(
      (r) =>
        isIndependentDecision(r.fields) &&
        r.fields.approval_id === approvalId &&
        isPriorOrSame(r, c),
    );
    const { latest, ambiguous } = pickLatest(decisions);
    if (ambiguous) {
      reports.push({
        code: "ambiguous_decision_order",
        message: `approval_id=${approvalId}: grant and deny tied at same order_ts (fail-closed as deny)`,
        effect_id: c.fields.effect_id,
        approval_id: approvalId,
        indices: decisions.map((d) => d.index),
      });
    }

    const effectDecisions = indexed.filter(
      (r) =>
        isIndependentDecision(r.fields) &&
        r.fields.effect_id === c.fields.effect_id &&
        isPriorOrSame(r, c),
    );
    const { latest: latestEffect } = pickLatest(effectDecisions);

    if (latest && isDeny(latest.fields)) {
      violations.push({
        code: "revoked_approval_used",
        message: `committed effect_id=${c.fields.effect_id} uses approval_id=${approvalId} after latest prior decision=deny`,
        effect_id: c.fields.effect_id,
        approval_id: approvalId,
        indices: [latest.index, c.index],
      });
      continue;
    }

    if (!latest || !isGrant(latest.fields)) {
      // No independent grant for this approval_id.
      if (requireIssuance) {
        violations.push({
          code: "unauthorized_effect",
          message: `committed effect_id=${c.fields.effect_id} requires independent issuance for approval_id=${approvalId} (requireIssuance)`,
          effect_id: c.fields.effect_id,
          approval_id: approvalId,
          indices: [c.index],
        });
        continue;
      }

      // Effect-level revoke check order unchanged (before loose eligibility).
      if (latestEffect && isDeny(latestEffect.fields)) {
        violations.push({
          code: "committed_after_deny",
          message: `committed effect_id=${c.fields.effect_id} after effect-level deny (approval_id=${approvalId} never independently granted)`,
          effect_id: c.fields.effect_id,
          approval_id: approvalId,
          indices: [latestEffect.index, c.index],
        });
      }

      // Loose path ONLY for legacy (no record_kind) + approval_decision===grant.
      // record_kind="effect", decision none/deny/missing, etc. → unauthorized_effect.
      const looseEligible =
        c.fields.record_kind === undefined &&
        c.fields.approval_decision === "grant" &&
        hasApprovalId(c.fields);
      if (!looseEligible) {
        violations.push({
          code: "unauthorized_effect",
          message: `committed effect_id=${c.fields.effect_id} has no prior grant for approval_id=${approvalId} (loose mode requires legacy format with approval_decision=grant)`,
          effect_id: c.fields.effect_id,
          approval_id: approvalId,
          indices: [c.index],
        });
        continue;
      }

      // Soft: generation unverifiable without independent issuance.
      reports.push({
        code: "approval_generation_unverifiable",
        message: `committed effect_id=${c.fields.effect_id} approval_id=${approvalId}: no independent issuance record to establish approval generation`,
        effect_id: c.fields.effect_id,
        approval_id: approvalId,
        indices: [c.index],
      });

      // Self-admitted generation mismatch → hard cross_generation_reuse.
      if (
        typeof c.fields.approval_runtime_generation === "number" &&
        c.fields.approval_runtime_generation !== c.fields.runtime_generation
      ) {
        violations.push({
          code: "cross_generation_reuse",
          message: `self-declared approval_runtime_generation=${c.fields.approval_runtime_generation} != effect runtime_generation=${c.fields.runtime_generation} for effect_id=${c.fields.effect_id} approval_id=${approvalId}`,
          effect_id: c.fields.effect_id,
          approval_id: approvalId,
          indices: [c.index],
        });
      }
      continue;
    }

    // Independent grant is latest for approval_id.
    // Effect-level deny (any approval_id) after/at latest effect decision → committed_after_deny.
    if (latestEffect && isDeny(latestEffect.fields)) {
      violations.push({
        code: "committed_after_deny",
        message: `committed effect_id=${c.fields.effect_id} after later effect-level deny (claimed approval_id=${approvalId})`,
        effect_id: c.fields.effect_id,
        approval_id: approvalId,
        indices: [latestEffect.index, c.index],
      });
      continue;
    }

    // Binding grant for digest / fence / generation / effect match.
    const bindingGrant = latest;

    if (bindingGrant.fields.effect_id !== c.fields.effect_id) {
      violations.push({
        code: "approval_effect_mismatch",
        message: `approval_id=${approvalId} issued for effect_id=${bindingGrant.fields.effect_id} but used by committed effect_id=${c.fields.effect_id}`,
        effect_id: c.fields.effect_id,
        approval_id: approvalId,
        indices: [bindingGrant.index, c.index],
      });
      continue;
    }

    if (bindingGrant.fields.action_digest !== c.fields.action_digest) {
      violations.push({
        code: "approval_digest_mismatch",
        message: `approval action_digest=${bindingGrant.fields.action_digest} != effect action_digest=${c.fields.action_digest} for effect_id=${c.fields.effect_id}`,
        effect_id: c.fields.effect_id,
        approval_id: approvalId,
        indices: [bindingGrant.index, c.index],
      });
    }

    if (c.fields.fence_epoch < bindingGrant.fields.fence_epoch) {
      violations.push({
        code: "effect_fence_before_approval",
        message: `effect fence_epoch=${c.fields.fence_epoch} < approval fence_epoch=${bindingGrant.fields.fence_epoch} for effect_id=${c.fields.effect_id}`,
        effect_id: c.fields.effect_id,
        approval_id: approvalId,
        indices: [bindingGrant.index, c.index],
      });
    }

    // Generation binding: independent issuance wins for the issuance check.
    // Separately: commit self-declared approval_runtime_generation ≠ own
    // runtime_generation is ALWAYS cross_generation_reuse (stricter only).
    // Report cross_generation_reuse at most once per commit.
    let reportedCrossGen = false;
    const gen = issuanceGeneration(bindingGrant);
    if (gen !== c.fields.runtime_generation) {
      violations.push({
        code: "cross_generation_reuse",
        message: `approval runtime_generation=${gen} != effect runtime_generation=${c.fields.runtime_generation} for effect_id=${c.fields.effect_id} approval_id=${approvalId}`,
        effect_id: c.fields.effect_id,
        approval_id: approvalId,
        indices: [bindingGrant.index, c.index],
      });
      reportedCrossGen = true;
    }
    if (
      !reportedCrossGen &&
      typeof c.fields.approval_runtime_generation === "number" &&
      c.fields.approval_runtime_generation !== c.fields.runtime_generation
    ) {
      violations.push({
        code: "cross_generation_reuse",
        message: `self-declared approval_runtime_generation=${c.fields.approval_runtime_generation} != effect runtime_generation=${c.fields.runtime_generation} for effect_id=${c.fields.effect_id} approval_id=${approvalId}`,
        effect_id: c.fields.effect_id,
        approval_id: approvalId,
        indices: [c.index],
      });
    }
  }

  // Rule 4a + 7: per-stream fence monotonicity and sequence integrity.
  const byStream = new Map<string, IndexedRecord[]>();
  for (const rec of indexed) {
    const list = byStream.get(rec.fields.stream_id) ?? [];
    list.push(rec);
    byStream.set(rec.fields.stream_id, list);
  }

  for (const [streamId, group] of byStream) {
    const ordered = [...group].sort((a, b) => {
      if (a.fields.sequence_number !== b.fields.sequence_number) {
        return a.fields.sequence_number - b.fields.sequence_number;
      }
      return a.index - b.index;
    });

    const seqCounts = new Map<number, number[]>();
    for (const rec of ordered) {
      const idxs = seqCounts.get(rec.fields.sequence_number) ?? [];
      idxs.push(rec.index);
      seqCounts.set(rec.fields.sequence_number, idxs);
    }
    for (const [seq, idxs] of seqCounts) {
      if (idxs.length > 1) {
        violations.push({
          code: "duplicate_sequence",
          message: `stream_id=${streamId} has duplicate sequence_number=${seq}`,
          stream_id: streamId,
          indices: idxs,
        });
      }
    }

    const seqs = [...seqCounts.keys()].sort((a, b) => a - b);
    const MAX_ENUMERATED_MISSING = 4096;
    for (let i = 1; i < seqs.length; i++) {
      const prev = seqs[i - 1]!;
      const next = seqs[i]!;
      if (next - prev <= 1) continue;
      const span = next - prev - 1;
      const missing: number[] = [];
      if (span <= MAX_ENUMERATED_MISSING) {
        for (let s = prev + 1; s < next; s++) missing.push(s);
      }
      gaps.push({
        code: "sequence_gap",
        stream_id: streamId,
        missing,
        from: prev,
        to: next,
      });
    }

    let lastEpoch: number | undefined;
    let lastIdx: number | undefined;
    let lastSeq: number | undefined;
    for (const rec of ordered) {
      const hard =
        rec.fields.outcome === "committed" || isApprovalRecord(rec.fields);
      if (!hard) {
        if (
          (rec.fields.outcome === "rejected" || rec.fields.outcome === "failed") &&
          lastEpoch !== undefined &&
          rec.fields.fence_epoch < lastEpoch
        ) {
          reports.push({
            code: "rejected_stale_fence",
            message: `stream_id=${streamId}: rejected/failed record fence_epoch=${rec.fields.fence_epoch} < prior committed/approval fence_epoch=${lastEpoch} at sequence_number=${rec.fields.sequence_number}`,
            effect_id: rec.fields.effect_id,
            indices: lastIdx !== undefined ? [lastIdx, rec.index] : [rec.index],
          });
        }
        continue;
      }
      if (lastSeq !== undefined && rec.fields.sequence_number === lastSeq) {
        if (lastEpoch !== undefined && rec.fields.fence_epoch < lastEpoch) {
          violations.push({
            code: "fence_epoch_regression",
            message: `stream_id=${streamId} fence_epoch went backwards ${lastEpoch} -> ${rec.fields.fence_epoch} at sequence_number=${rec.fields.sequence_number}`,
            stream_id: streamId,
            indices: [lastIdx!, rec.index],
          });
        }
        continue;
      }
      if (lastEpoch !== undefined && rec.fields.fence_epoch < lastEpoch) {
        violations.push({
          code: "fence_epoch_regression",
          message: `stream_id=${streamId} fence_epoch went backwards ${lastEpoch} -> ${rec.fields.fence_epoch} at sequence_number=${rec.fields.sequence_number}`,
          stream_id: streamId,
          indices: [lastIdx!, rec.index],
        });
      }
      lastEpoch = rec.fields.fence_epoch;
      lastIdx = rec.index;
      lastSeq = rec.fields.sequence_number;
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    gaps,
    unknowns,
    reports,
  };
}

/** Parse JSONL text into objects (skips blank lines). */
export function parseJsonl(text: string): unknown[] {
  const out: unknown[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    try {
      out.push(JSON.parse(line));
    } catch (e) {
      throw new Error(`JSONL line ${i + 1}: ${(e as Error).message}`);
    }
  }
  return out;
}
