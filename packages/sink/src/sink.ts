import { createHash } from "node:crypto";
import { canonicalize } from "@asa/core";
import type {
  AcceptRequest,
  AcceptResult,
  AgentEffectRecord,
  EffectOutcome,
  EffectReceipt,
  FaultMode,
  FenceRequest,
  FenceResult,
  GrantRequest,
  ObservationEntry,
  SinkSnapshot,
} from "./types.js";

function now_iso(): string {
  return new Date().toISOString();
}

/** Keys excluded from evidence hashed form (spec/agent-effect-attributes.md). */
const HASH_EXCLUDE = new Set(["previousEvidenceHash", "signature"]);

function strip_for_hash(receipt: EffectReceipt): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(receipt)) {
    if (HASH_EXCLUDE.has(k)) continue;
    if (/^integrity(\.|_)/.test(k) || k === "integrity") continue;
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

/** Evidence hash of one receipt (JCS of stripped form). Independent of key order. */
export function hash_receipt(receipt: EffectReceipt): string {
  const h = createHash("sha256");
  h.update(canonicalize(strip_for_hash(receipt)));
  return h.digest("hex");
}

function iso_to_unix_nano(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "0";
  return (BigInt(ms) * 1_000_000n).toString();
}

export interface MockEffectSinkOptions {
  boundaryId?: string;
  runtimeGeneration?: number;
  fenceEpoch?: number;
  faultMode?: FaultMode;
  delayMs?: number;
  clock?: () => string;
  /** When true, enforce fence/generation/holder + approval binding. Default OFF. */
  enforce?: boolean;
  /** Initial scopeId → holder controller map. */
  holders?: Record<string, string>;
}

/**
 * In-process mock effect sink: ledger + fault inject + snapshot/restore.
 * Observation log is intentionally NOT rolled back by restore().
 */
export class MockEffectSink {
  private commitCount = 0;
  private ledger: EffectReceipt[] = [];
  private pending = new Map<string, EffectReceipt>();
  private committedIds = new Map<string, EffectReceipt>();
  /** approval_id → effectId that committed with it. */
  private usedApprovals = new Map<string, string>();
  private faultMode: FaultMode = "none";
  private delayMs = 0;
  private defaultRuntimeGeneration: number;
  private defaultFenceEpoch: number;
  private boundaryId: string;
  private lastEvidenceHash: string | null = null;
  private readonly observationLog: ObservationEntry[] = [];
  private readonly clock: () => string;
  private readonly enforce: boolean;
  private readonly holders = new Map<string, string>();
  /** Per-effectId serialization: claim slot before any await. */
  private readonly effectChains = new Map<string, Promise<unknown>>();

  constructor(opts: MockEffectSinkOptions = {}) {
    this.boundaryId = opts.boundaryId ?? "mock_effect_boundary";
    this.defaultRuntimeGeneration = opts.runtimeGeneration ?? 1;
    this.defaultFenceEpoch = opts.fenceEpoch ?? 1;
    this.faultMode = opts.faultMode ?? "none";
    this.delayMs = opts.delayMs ?? 0;
    this.clock = opts.clock ?? now_iso;
    this.enforce = opts.enforce ?? false;
    if (opts.holders) {
      for (const [k, v] of Object.entries(opts.holders)) this.holders.set(k, v);
    }
    this.observe("sink.create", {
      boundaryId: this.boundaryId,
      enforce: this.enforce,
    });
  }

  observe(type: string, detail: Record<string, unknown> = {}): void {
    this.observationLog.push({ at: this.clock(), type, detail });
  }

  setFaultMode(mode: FaultMode, delayMs?: number): void {
    this.faultMode = mode;
    if (typeof delayMs === "number") this.delayMs = delayMs;
    this.observe("sink.fault_mode", { mode: this.faultMode, delayMs: this.delayMs });
  }

  getFaultMode(): FaultMode {
    return this.faultMode;
  }

  getCommitCount(): number {
    return this.commitCount;
  }

  getObservationLog(): readonly ObservationEntry[] {
    return this.observationLog;
  }

  getEnforce(): boolean {
    return this.enforce;
  }

  getFenceEpoch(): number {
    return this.defaultFenceEpoch;
  }

  getRuntimeGeneration(): number {
    return this.defaultRuntimeGeneration;
  }

  getHolders(): Record<string, string> {
    return Object.fromEntries(this.holders.entries());
  }

  exportLedger(): EffectReceipt[] {
    return this.ledger.map((r) => ({ ...r }));
  }

  /**
   * First producer of asa.agent-effect/0.1: map ledger → AgentEffectRecord (snake_case).
   * sequence_number assigned by sink write order (1-based).
   */
  exportAgentEffectRecords(): AgentEffectRecord[] {
    return this.ledger.map((r, i) => {
      const rec: AgentEffectRecord = {
        schema_version: "asa.agent-effect/0.1",
        effect_id: r.effectId,
        action_digest: r.actionDigest,
        runtime_generation: r.runtimeGeneration,
        fence_epoch: r.fenceEpoch,
        boundary_id: r.boundaryId,
        outcome: r.outcome,
        stream_id: `boundary/${r.boundaryId}`,
        sequence_number: i + 1,
        ts_unix_nano: iso_to_unix_nano(r.observedAt),
        ts: r.observedAt,
        external_reference: r.externalReference,
        previous_evidence_hash: r.previousEvidenceHash,
      };
      if (r.controller !== undefined) rec.controller = r.controller;
      if (r.scopeId !== undefined) rec.scope_id = r.scopeId;
      if (r.approvalDecision !== undefined) rec.approval_decision = r.approvalDecision;
      if (r.approvalId !== undefined) rec.approval_id = r.approvalId;
      if (r.approvalRuntimeGeneration !== undefined) {
        rec.approval_runtime_generation = r.approvalRuntimeGeneration;
      }
      if (r.signature !== undefined) rec.signature = r.signature;
      return rec;
    });
  }

  snapshot(): SinkSnapshot {
    return {
      commitCount: this.commitCount,
      ledger: this.exportLedger(),
      pending: Object.fromEntries([...this.pending.entries()].map(([k, v]) => [k, { ...v }])),
      faultMode: this.faultMode,
      delayMs: this.delayMs,
      defaultRuntimeGeneration: this.defaultRuntimeGeneration,
      defaultFenceEpoch: this.defaultFenceEpoch,
      boundaryId: this.boundaryId,
      lastEvidenceHash: this.lastEvidenceHash,
      enforce: this.enforce,
      holders: this.getHolders(),
    };
  }

  /** Restore sink state. Observation log is preserved (not rolled back). */
  restore(snap: SinkSnapshot): void {
    this.commitCount = snap.commitCount;
    this.ledger = snap.ledger.map((r) => ({ ...r }));
    this.pending = new Map(Object.entries(snap.pending).map(([k, v]) => [k, { ...v }]));
    this.committedIds = new Map(
      this.ledger.filter((r) => r.outcome === "committed").map((r) => [r.effectId, r]),
    );
    this.usedApprovals = new Map();
    for (const r of this.ledger) {
      if (r.outcome === "committed" && r.approvalId) {
        this.usedApprovals.set(r.approvalId, r.effectId);
      }
    }
    this.faultMode = snap.faultMode;
    this.delayMs = snap.delayMs;
    this.defaultRuntimeGeneration = snap.defaultRuntimeGeneration;
    this.defaultFenceEpoch = snap.defaultFenceEpoch;
    this.boundaryId = snap.boundaryId;
    this.lastEvidenceHash = snap.lastEvidenceHash;
    this.holders.clear();
    if (snap.holders) {
      for (const [k, v] of Object.entries(snap.holders)) this.holders.set(k, v);
    }
    this.observe("sink.restore", {
      commitCount: this.commitCount,
      ledgerLen: this.ledger.length,
      observationLogLen: this.observationLog.length,
    });
  }

  /**
   * Advance fenceEpoch, runtimeGeneration, and/or change a scope's holder.
   * Only increment (or equal) allowed; decrement → rejected.
   */
  fence(req: FenceRequest): FenceResult {
    if (typeof req.fenceEpoch === "number") {
      if (req.fenceEpoch < this.defaultFenceEpoch) {
        this.observe("sink.fence_reject", {
          reason: "fence_decrement",
          requested: req.fenceEpoch,
          current: this.defaultFenceEpoch,
        });
        return {
          ok: false,
          reason: "fence_decrement",
          fenceEpoch: this.defaultFenceEpoch,
          runtimeGeneration: this.defaultRuntimeGeneration,
          holders: this.getHolders(),
        };
      }
      this.defaultFenceEpoch = req.fenceEpoch;
    }
    if (typeof req.runtimeGeneration === "number") {
      if (req.runtimeGeneration < this.defaultRuntimeGeneration) {
        this.observe("sink.fence_reject", {
          reason: "generation_decrement",
          requested: req.runtimeGeneration,
          current: this.defaultRuntimeGeneration,
        });
        return {
          ok: false,
          reason: "generation_decrement",
          fenceEpoch: this.defaultFenceEpoch,
          runtimeGeneration: this.defaultRuntimeGeneration,
          holders: this.getHolders(),
        };
      }
      this.defaultRuntimeGeneration = req.runtimeGeneration;
    }
    if (typeof req.scopeId === "string" && typeof req.holder === "string") {
      const prev = this.holders.get(req.scopeId);
      this.holders.set(req.scopeId, req.holder);
      this.observe("sink.fence_holder", {
        scopeId: req.scopeId,
        previousHolder: prev ?? null,
        holder: req.holder,
      });
    }
    this.observe("sink.fence", {
      fenceEpoch: this.defaultFenceEpoch,
      runtimeGeneration: this.defaultRuntimeGeneration,
      holders: this.getHolders(),
      request: req as unknown as Record<string, unknown>,
    });
    return {
      ok: true,
      fenceEpoch: this.defaultFenceEpoch,
      runtimeGeneration: this.defaultRuntimeGeneration,
      holders: this.getHolders(),
    };
  }

  /**
   * Record an approval grant/deny issuance (outcome=unknown) for agent-effect export.
   */
  grant(req: GrantRequest): AcceptResult {
    if (!req.effectId || !req.actionDigest || !req.approvalId) {
      return {
        accepted: false,
        receipt: null,
        reason: "effectId, actionDigest, and approvalId required",
      };
    }
    const decision = req.decision ?? "grant";
    const receipt = this.appendLedger(
      this.buildReceipt(
        {
          effectId: req.effectId,
          actionDigest: req.actionDigest,
          runtimeGeneration: req.runtimeGeneration,
          fenceEpoch: req.fenceEpoch,
          boundaryId: req.boundaryId,
          controller: req.controller,
          scopeId: req.scopeId,
        },
        "unknown",
        {
          approvalId: req.approvalId,
          approvalDecision: decision,
          approvalRuntimeGeneration: req.runtimeGeneration ?? this.defaultRuntimeGeneration,
        },
      ),
    );
    this.observe("sink.grant", {
      effectId: req.effectId,
      approvalId: req.approvalId,
      decision,
    });
    return { accepted: true, receipt };
  }

  private buildReceipt(
    req: Pick<
      AcceptRequest,
      | "effectId"
      | "actionDigest"
      | "runtimeGeneration"
      | "fenceEpoch"
      | "boundaryId"
      | "controller"
      | "scopeId"
    >,
    outcome: EffectOutcome,
    approval?: {
      approvalId?: string;
      approvalDecision?: "grant" | "deny" | "none";
      approvalRuntimeGeneration?: number;
    },
  ): EffectReceipt {
    const observedAt = this.clock();
    const receipt: EffectReceipt = {
      effectId: req.effectId,
      actionDigest: req.actionDigest,
      runtimeGeneration: req.runtimeGeneration ?? this.defaultRuntimeGeneration,
      fenceEpoch: req.fenceEpoch ?? this.defaultFenceEpoch,
      boundaryId: req.boundaryId ?? this.boundaryId,
      outcome,
      externalReference:
        outcome === "committed" ? `mock://${this.boundaryId}/${req.effectId}` : null,
      observedAt,
      previousEvidenceHash: this.lastEvidenceHash,
    };
    if (req.controller !== undefined) receipt.controller = req.controller;
    if (req.scopeId !== undefined) receipt.scopeId = req.scopeId;
    if (approval?.approvalId !== undefined) receipt.approvalId = approval.approvalId;
    if (approval?.approvalDecision !== undefined) {
      receipt.approvalDecision = approval.approvalDecision;
    }
    if (approval?.approvalRuntimeGeneration !== undefined) {
      receipt.approvalRuntimeGeneration = approval.approvalRuntimeGeneration;
    }
    return receipt;
  }

  private appendLedger(receipt: EffectReceipt): EffectReceipt {
    const sealed = { ...receipt };
    this.ledger.push(sealed);
    this.lastEvidenceHash = hash_receipt(sealed);
    if (sealed.outcome === "committed") {
      this.commitCount += 1;
      this.committedIds.set(sealed.effectId, sealed);
      if (sealed.approvalId) {
        this.usedApprovals.set(sealed.approvalId, sealed.effectId);
      }
    }
    this.observe("sink.ledger_append", {
      effectId: sealed.effectId,
      outcome: sealed.outcome,
      commitCount: this.commitCount,
    });
    return sealed;
  }

  private reject(
    req: AcceptRequest,
    reason: string,
    approval?: {
      approvalId?: string;
      approvalDecision?: "grant" | "deny" | "none";
      approvalRuntimeGeneration?: number;
    },
  ): AcceptResult {
    const rejected = this.appendLedger(this.buildReceipt(req, "rejected", approval));
    return { accepted: false, receipt: rejected, reason };
  }

  private enforceChecks(req: AcceptRequest): AcceptResult | null {
    if (!this.enforce) return null;

    const reqFence = req.fenceEpoch ?? this.defaultFenceEpoch;
    if (reqFence < this.defaultFenceEpoch) {
      return this.reject(req, "stale_fence");
    }

    const reqGen = req.runtimeGeneration ?? this.defaultRuntimeGeneration;
    if (reqGen !== this.defaultRuntimeGeneration) {
      return this.reject(req, "generation_mismatch");
    }

    if (req.scopeId) {
      const holder = this.holders.get(req.scopeId);
      if (holder !== undefined && req.controller !== holder) {
        return this.reject(req, "not_holder");
      }
    }

    if (!req.approval) {
      return this.reject(req, "missing_approval");
    }
    const appr = req.approval;
    if (appr.decision !== "grant") {
      return this.reject(
        req,
        "approval_denied",
        {
          approvalId: appr.approval_id,
          approvalDecision: appr.decision,
          approvalRuntimeGeneration: appr.runtime_generation,
        },
      );
    }
    if (appr.action_digest !== req.actionDigest) {
      return this.reject(
        req,
        "approval_digest_mismatch",
        {
          approvalId: appr.approval_id,
          approvalDecision: appr.decision,
          approvalRuntimeGeneration: appr.runtime_generation,
        },
      );
    }
    if (appr.runtime_generation !== this.defaultRuntimeGeneration) {
      return this.reject(
        req,
        "approval_generation_mismatch",
        {
          approvalId: appr.approval_id,
          approvalDecision: appr.decision,
          approvalRuntimeGeneration: appr.runtime_generation,
        },
      );
    }
    const priorUse = this.usedApprovals.get(appr.approval_id);
    if (priorUse !== undefined && priorUse !== req.effectId) {
      return this.reject(
        req,
        "approval_reused",
        {
          approvalId: appr.approval_id,
          approvalDecision: appr.decision,
          approvalRuntimeGeneration: appr.runtime_generation,
        },
      );
    }

    return null;
  }

  /**
   * Accept an effect at the boundary. Honors fault injection modes.
   * Idempotent: same effectId+actionDigest commit returns prior receipt (resend-safe).
   * Same effectId accepts are serialized (per-effectId lock / claim-before-await).
   */
  async accept(req: AcceptRequest): Promise<AcceptResult> {
    const prev = this.effectChains.get(req.effectId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const chained = prev.then(() => gate);
    this.effectChains.set(req.effectId, chained);
    await prev;
    try {
      return await this.acceptLocked(req);
    } finally {
      release();
      if (this.effectChains.get(req.effectId) === chained) {
        this.effectChains.delete(req.effectId);
      }
    }
  }

  private async acceptLocked(req: AcceptRequest): Promise<AcceptResult> {
    this.observe("sink.accept_request", {
      effectId: req.effectId,
      actionDigest: req.actionDigest,
      faultMode: this.faultMode,
    });

    if (!req.effectId || !req.actionDigest) {
      return { accepted: false, receipt: null, reason: "effectId and actionDigest required" };
    }

    const prior = this.committedIds.get(req.effectId);
    if (prior) {
      if (prior.actionDigest !== req.actionDigest) {
        return this.reject(req, "digest_mismatch");
      }
      this.observe("sink.resend_hit", { effectId: req.effectId });
      // Pull from pending and clear after lost_reply resend.
      if (this.pending.has(req.effectId)) {
        const fromPending = this.pending.get(req.effectId)!;
        this.pending.delete(req.effectId);
        this.observe("sink.pending_clear", { effectId: req.effectId });
        if (this.faultMode === "lost_reply") {
          return { accepted: true, receipt: null, suppressed: true, resent: true };
        }
        return { accepted: true, receipt: { ...fromPending }, resent: true };
      }
      if (this.faultMode === "lost_reply") {
        return { accepted: true, receipt: null, suppressed: true, resent: true };
      }
      return { accepted: true, receipt: { ...prior }, resent: true };
    }

    const enforced = this.enforceChecks(req);
    if (enforced) return enforced;

    if (this.faultMode === "timeout") {
      this.observe("sink.timeout", { effectId: req.effectId });
      return { accepted: false, receipt: null, reason: "injected timeout" };
    }

    if (this.faultMode === "delay" && this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }

    const outcome: EffectOutcome = req.forceOutcome ?? "committed";
    const approvalMeta = req.approval
      ? {
          approvalId: req.approval.approval_id,
          approvalDecision: req.approval.decision,
          approvalRuntimeGeneration: req.approval.runtime_generation,
        }
      : undefined;
    const receipt = this.appendLedger(this.buildReceipt(req, outcome, approvalMeta));

    if (this.faultMode === "lost_reply") {
      this.pending.set(req.effectId, receipt);
      this.observe("sink.lost_reply", { effectId: req.effectId });
      return { accepted: true, receipt: null, suppressed: true };
    }

    if (this.faultMode === "resend") {
      this.observe("sink.resend_mode_first", { effectId: req.effectId });
      this.faultMode = "none";
      return { accepted: true, receipt: null, suppressed: true };
    }

    // outcome=rejected → accepted:false (HTTP 400). failed stays accepted for processed attempts.
    return {
      accepted: outcome === "committed" || outcome === "failed",
      receipt,
      ...(outcome === "rejected" ? { reason: "outcome_rejected" } : {}),
    };
  }
}
