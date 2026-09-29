/**
 * Offline cross-record authority checks for asa.agent-effect/0.1 JSONL sets.
 *
 * Proves mutual consistency among AgentEffectRecord emissions.
 * Does NOT prove external effects happened; does NOT verify signatures or hash chains.
 *
 * Approvals are indexed by approval_id (not effect_id). Self-declared approval
 * fields on a committed record are a claim, not independent issuance evidence.
 */
import { verifyAgentEffectRecord } from "./profile.js";

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
  | "invalid_record";

export type CrossReportCode = "approval_generation_unverifiable" | "rejected_digest_variant";

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

function isGrant(f: AgentEffectFields): boolean {
  return f.approval_decision === "grant" && hasApprovalId(f);
}

function isDeny(f: AgentEffectFields): boolean {
  return f.approval_decision === "deny" && hasApprovalId(f);
}

function isDecision(f: AgentEffectFields): boolean {
  return isGrant(f) || isDeny(f);
}

/**
 * Explicit approval records, or legacy issuance (decision + non-committed, no record_kind).
 * record_kind="effect" MUST NOT be treated as approval even if approval fields are present
 * (e.g. a rejected accept that echoed approval_id). Legacy only when record_kind absent.
 */
function isApprovalRecord(f: AgentEffectFields): boolean {
  if (f.record_kind === "approval") return true;
  if (f.record_kind === "effect") return false;
  // absent record_kind: treat non-committed decisions as approval issuance (legacy vectors)
  return isDecision(f) && f.outcome !== "committed";
}

/** Unknowns report lists only effect-kind records (default when record_kind absent). */
function isEffectKindForUnknowns(f: AgentEffectFields): boolean {
  return f.record_kind !== "approval";
}

/**
 * True when approval/decision A is at-or-before committed effect C (same record counts).
 * Same-stream order uses sequence_number. Cross-stream order falls back to ts_unix_nano
 * as a *reference* clock only — the profile treats ts as non-causal; do not treat this
 * ordering as proof of happened-before across streams.
 */
function isPriorOrSame(a: IndexedRecord, c: IndexedRecord): boolean {
  if (a.index === c.index) return true;
  if (a.fields.stream_id === c.fields.stream_id) {
    return a.fields.sequence_number <= c.fields.sequence_number;
  }
  try {
    return BigInt(a.fields.ts_unix_nano) <= BigInt(c.fields.ts_unix_nano);
  } catch {
    return a.fields.ts_unix_nano <= c.fields.ts_unix_nano;
  }
}

/** Sort key: later records come first when sorting descending. */
function compareAscending(a: IndexedRecord, b: IndexedRecord): number {
  if (a.fields.stream_id === b.fields.stream_id) {
    if (a.fields.sequence_number !== b.fields.sequence_number) {
      return a.fields.sequence_number - b.fields.sequence_number;
    }
    return a.index - b.index;
  }
  try {
    const d = BigInt(a.fields.ts_unix_nano) - BigInt(b.fields.ts_unix_nano);
    if (d < 0n) return -1;
    if (d > 0n) return 1;
  } catch {
    if (a.fields.ts_unix_nano < b.fields.ts_unix_nano) return -1;
    if (a.fields.ts_unix_nano > b.fields.ts_unix_nano) return 1;
  }
  return a.index - b.index;
}

/** Latest prior decision wins (not earliest). */
function pickLatest(recs: IndexedRecord[]): IndexedRecord | undefined {
  if (recs.length === 0) return undefined;
  const sorted = [...recs].sort(compareAscending);
  return sorted[sorted.length - 1];
}

/**
 * Issuance generation for approval_id as bound to committed c.
 * Prefer explicit approval_runtime_generation; else a separate issuance grant record.
 * Same-record self-declaration alone is not independent evidence → undefined.
 */
function resolveIssuanceGeneration(
  approvalId: string,
  committed: IndexedRecord,
  indexed: IndexedRecord[],
): { generation: number; evidence: IndexedRecord } | undefined {
  if (typeof committed.fields.approval_runtime_generation === "number") {
    return {
      generation: committed.fields.approval_runtime_generation,
      evidence: committed,
    };
  }

  // Issuance evidence: grant records that are not themselves committed uses.
  // Another effect's committed self-declaration is a claim of use, not issuance.
  const separateIssuances = indexed.filter(
    (r) =>
      r.index !== committed.index &&
      isGrant(r.fields) &&
      r.fields.outcome !== "committed" &&
      r.fields.approval_id === approvalId &&
      isPriorOrSame(r, committed),
  );
  const issuance = pickLatest(separateIssuances);
  if (!issuance) return undefined;

  const gen =
    typeof issuance.fields.approval_runtime_generation === "number"
      ? issuance.fields.approval_runtime_generation
      : issuance.fields.runtime_generation;
  return { generation: gen, evidence: issuance };
}

/**
 * Resolve which approval_id a committed effect claims.
 * Prefer the record's own approval_id; if absent, fall back to the latest prior
 * grant/deny decision on the same effect_id (covers commit-after-revoke with
 * stripped approval fields). Does not invent approvals from unrelated effects.
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
      isDecision(r.fields) &&
      isPriorOrSame(r, committed),
  );
  const latest = pickLatest(priorOnEffect);
  return latest?.fields.approval_id;
}

/**
 * Verify a set of AgentEffectRecord objects (JSONL lines parsed to objects).
 */
export function verifyCrossRecords(rawRecords: unknown[]): CrossVerifyResult {
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
    const fields = asFields(raw as Record<string, unknown>);
    indexed.push({ index: i, fields });

    // Rule 6: list unknowns separately; never treat as committed or failed.
    // Only record_kind=effect (default) — approval issuances are not listed.
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

  // Group by effect_id for digest consistency + duplicate commits.
  const byEffect = new Map<string, IndexedRecord[]>();
  for (const rec of indexed) {
    const list = byEffect.get(rec.fields.effect_id) ?? [];
    list.push(rec);
    byEffect.set(rec.fields.effect_id, list);
  }

  for (const [effectId, group] of byEffect) {
    // Rule 2: digest consistency only among committed effects + approval records.
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

    // rejected/failed with a digest that diverges from the hard set → soft report only.
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

  // approval_reused_across_effects: same approval_id on committed records of different effect_ids.
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

  // Per committed: resolve approval_id → latest prior decision; generation via issuance evidence.
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
        isDecision(r.fields) &&
        r.fields.approval_id === approvalId &&
        isPriorOrSame(r, c),
    );
    const latest = pickLatest(decisions);

    if (!latest || !isGrant(latest.fields)) {
      if (latest && isDeny(latest.fields)) {
        violations.push({
          code: "revoked_approval_used",
          message: `committed effect_id=${c.fields.effect_id} uses approval_id=${approvalId} after latest prior decision=deny`,
          effect_id: c.fields.effect_id,
          approval_id: approvalId,
          indices: [latest.index, c.index],
        });
      } else {
        violations.push({
          code: "unauthorized_effect",
          message: `committed effect_id=${c.fields.effect_id} has no prior grant for approval_id=${approvalId}`,
          effect_id: c.fields.effect_id,
          approval_id: approvalId,
          indices: [c.index],
        });
      }
      continue;
    }

    // Binding grant for digest / fence: prefer separate non-committed issuance; else same-record claim.
    const separateGrants = decisions.filter(
      (r) =>
        isGrant(r.fields) &&
        r.index !== c.index &&
        r.fields.outcome !== "committed",
    );
    const bindingGrant = pickLatest(separateGrants) ?? latest;

    // Rule 2 (approval-bound): approval digest must equal effect digest.
    if (bindingGrant.fields.action_digest !== c.fields.action_digest) {
      violations.push({
        code: "approval_digest_mismatch",
        message: `approval action_digest=${bindingGrant.fields.action_digest} != effect action_digest=${c.fields.action_digest} for effect_id=${c.fields.effect_id}`,
        effect_id: c.fields.effect_id,
        approval_id: approvalId,
        indices: [bindingGrant.index, c.index],
      });
    }

    // Rule 4b: effect fence_epoch must not be lower than approval fence_epoch.
    if (c.fields.fence_epoch < bindingGrant.fields.fence_epoch) {
      violations.push({
        code: "effect_fence_before_approval",
        message: `effect fence_epoch=${c.fields.fence_epoch} < approval fence_epoch=${bindingGrant.fields.fence_epoch} for effect_id=${c.fields.effect_id}`,
        effect_id: c.fields.effect_id,
        approval_id: approvalId,
        indices: [bindingGrant.index, c.index],
      });
    }

    // Rule 3: generation binding via approval_runtime_generation or separate issuance.
    const issuance = resolveIssuanceGeneration(approvalId, c, indexed);
    if (!issuance) {
      reports.push({
        code: "approval_generation_unverifiable",
        message: `committed effect_id=${c.fields.effect_id} approval_id=${approvalId}: no approval_runtime_generation and no separate issuance record to establish approval generation`,
        effect_id: c.fields.effect_id,
        approval_id: approvalId,
        indices: [c.index],
      });
    } else if (issuance.generation !== c.fields.runtime_generation) {
      violations.push({
        code: "cross_generation_reuse",
        message: `approval runtime_generation=${issuance.generation} != effect runtime_generation=${c.fields.runtime_generation} for effect_id=${c.fields.effect_id} approval_id=${approvalId}`,
        effect_id: c.fields.effect_id,
        approval_id: approvalId,
        indices: [issuance.evidence.index, c.index],
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

    // Rule 7: duplicates (hard violation) and gaps (soft report).
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

    // Adjacent differences only — never walk every integer from min..max
    // (a jump like 1 → 1e12 would hang or OOM).
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

    // Rule 4a: fence_epoch must not go backwards within stream (by sequence_number).
    let lastEpoch: number | undefined;
    let lastIdx: number | undefined;
    let lastSeq: number | undefined;
    for (const rec of ordered) {
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
