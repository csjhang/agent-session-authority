/**
 * Offline cross-record authority checks for asa.agent-effect/0.1 JSONL sets.
 *
 * Proves mutual consistency among AgentEffectRecord emissions.
 * Does NOT prove external effects happened; does NOT verify signatures or hash chains.
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
  | "invalid_record";

export interface CrossViolation {
  code: CrossViolationCode;
  message: string;
  effect_id?: string;
  stream_id?: string;
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

export interface CrossVerifyResult {
  /** False when any hard violation is present. Gaps alone do not fail. */
  ok: boolean;
  violations: CrossViolation[];
  gaps: CrossGapReport[];
  unknowns: CrossUnknownReport[];
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
  };
}

function isGrant(f: AgentEffectFields): boolean {
  return f.approval_decision === "grant" && typeof f.approval_id === "string" && f.approval_id.length > 0;
}

/** True when approval A is at-or-before committed effect C (same record counts). */
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

function pickPriorGrant(grants: IndexedRecord[], committed: IndexedRecord): IndexedRecord | undefined {
  const priors = grants.filter((g) => isPriorOrSame(g, committed));
  if (priors.length === 0) return undefined;
  // Earliest prior grant is the binding authority (first grant wins).
  // Prefer a strictly earlier record when one exists so same-record grant
  // fields on the commit do not mask a mismatched earlier approval.
  const earlier = priors.filter((g) => g.index !== committed.index);
  const pool = earlier.length > 0 ? earlier : priors;
  pool.sort((x, y) => {
    if (x.fields.stream_id === y.fields.stream_id) {
      if (x.fields.sequence_number !== y.fields.sequence_number) {
        return x.fields.sequence_number - y.fields.sequence_number;
      }
      return x.index - y.index;
    }
    return x.index - y.index;
  });
  return pool[0];
}

/**
 * Verify a set of AgentEffectRecord objects (JSONL lines parsed to objects).
 */
export function verifyCrossRecords(rawRecords: unknown[]): CrossVerifyResult {
  const violations: CrossViolation[] = [];
  const gaps: CrossGapReport[] = [];
  const unknowns: CrossUnknownReport[] = [];
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
    if (fields.outcome === "unknown") {
      unknowns.push({
        effect_id: fields.effect_id,
        stream_id: fields.stream_id,
        sequence_number: fields.sequence_number,
        index: i,
      });
    }
  }

  if (violations.some((v) => v.code === "invalid_record")) {
    return { ok: false, violations, gaps, unknowns };
  }

  // Group by effect_id for digest consistency + approval binding.
  const byEffect = new Map<string, IndexedRecord[]>();
  for (const rec of indexed) {
    const list = byEffect.get(rec.fields.effect_id) ?? [];
    list.push(rec);
    byEffect.set(rec.fields.effect_id, list);
  }

  for (const [effectId, group] of byEffect) {
    // Rule 2: consistent action_digest for same effect_id.
    const digests = new Set(group.map((r) => r.fields.action_digest));
    if (digests.size > 1) {
      violations.push({
        code: "inconsistent_action_digest",
        message: `effect_id=${effectId} has multiple action_digest values: ${[...digests].join(", ")}`,
        effect_id: effectId,
        indices: group.map((r) => r.index),
      });
    }

    const grants = group.filter((r) => isGrant(r.fields));
    const committed = group.filter((r) => r.fields.outcome === "committed");

    for (const c of committed) {
      // Rules 1 + 5: committed requires a corresponding prior grant + approval_id.
      const grant = pickPriorGrant(grants, c);
      if (!grant) {
        violations.push({
          code: "unauthorized_effect",
          message: `committed effect_id=${effectId} has no prior approval (approval_decision=grant with approval_id)`,
          effect_id: effectId,
          indices: [c.index],
        });
        continue;
      }

      // Rule 2 (approval-bound): approval digest must equal effect digest.
      if (grant.fields.action_digest !== c.fields.action_digest) {
        violations.push({
          code: "approval_digest_mismatch",
          message: `approval action_digest=${grant.fields.action_digest} != effect action_digest=${c.fields.action_digest} for effect_id=${effectId}`,
          effect_id: effectId,
          indices: [grant.index, c.index],
        });
      }

      // Rule 3: approval runtime_generation must equal landing generation.
      if (grant.fields.runtime_generation !== c.fields.runtime_generation) {
        violations.push({
          code: "cross_generation_reuse",
          message: `approval runtime_generation=${grant.fields.runtime_generation} != effect runtime_generation=${c.fields.runtime_generation} for effect_id=${effectId}`,
          effect_id: effectId,
          indices: [grant.index, c.index],
        });
      }

      // Rule 4b: effect fence_epoch must not be lower than approval fence_epoch.
      if (c.fields.fence_epoch < grant.fields.fence_epoch) {
        violations.push({
          code: "effect_fence_before_approval",
          message: `effect fence_epoch=${c.fields.fence_epoch} < approval fence_epoch=${grant.fields.fence_epoch} for effect_id=${effectId}`,
          effect_id: effectId,
          indices: [grant.index, c.index],
        });
      }
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

    const seqs = [...seqCounts.keys()].sort((a, b) => a - b);
    if (seqs.length >= 2) {
      const missing: number[] = [];
      for (let s = seqs[0]!; s <= seqs[seqs.length - 1]!; s++) {
        if (!seqCounts.has(s)) missing.push(s);
      }
      if (missing.length > 0) {
        gaps.push({
          code: "sequence_gap",
          stream_id: streamId,
          missing,
          from: seqs[0]!,
          to: seqs[seqs.length - 1]!,
        });
      }
    }

    // Rule 4a: fence_epoch must not go backwards within stream (by sequence_number).
    let lastEpoch: number | undefined;
    let lastIdx: number | undefined;
    let lastSeq: number | undefined;
    for (const rec of ordered) {
      // Skip same-seq siblings after first when comparing monotonicity of epoch along seq order.
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
  };
}

/** Parse JSONL text into objects (skips blank lines). */
export function parseJsonl(text: string): unknown[] {
  const out: unknown[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch (e) {
      throw new Error(`JSONL line ${i + 1}: ${(e as Error).message}`);
    }
  }
  return out;
}
