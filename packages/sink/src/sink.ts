import { createHash } from "node:crypto";
import type {
  AcceptRequest,
  AcceptResult,
  EffectOutcome,
  EffectReceipt,
  FaultMode,
  ObservationEntry,
  SinkSnapshot,
} from "./types.js";

function now_iso(): string {
  return new Date().toISOString();
}

function hash_receipt(prev: string | null, receipt: EffectReceipt): string {
  const h = createHash("sha256");
  h.update(prev ?? "");
  h.update("|");
  h.update(JSON.stringify(receipt));
  return h.digest("hex");
}

export interface MockEffectSinkOptions {
  boundaryId?: string;
  runtimeGeneration?: number;
  fenceEpoch?: number;
  faultMode?: FaultMode;
  delayMs?: number;
  clock?: () => string;
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
  private faultMode: FaultMode = "none";
  private delayMs = 0;
  private defaultRuntimeGeneration: number;
  private defaultFenceEpoch: number;
  private boundaryId: string;
  private lastEvidenceHash: string | null = null;
  private readonly observationLog: ObservationEntry[] = [];
  private readonly clock: () => string;

  constructor(opts: MockEffectSinkOptions = {}) {
    this.boundaryId = opts.boundaryId ?? "mock_effect_boundary";
    this.defaultRuntimeGeneration = opts.runtimeGeneration ?? 1;
    this.defaultFenceEpoch = opts.fenceEpoch ?? 1;
    this.faultMode = opts.faultMode ?? "none";
    this.delayMs = opts.delayMs ?? 0;
    this.clock = opts.clock ?? now_iso;
    this.observe("sink.create", { boundaryId: this.boundaryId });
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

  exportLedger(): EffectReceipt[] {
    return this.ledger.map((r) => ({ ...r }));
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
    this.faultMode = snap.faultMode;
    this.delayMs = snap.delayMs;
    this.defaultRuntimeGeneration = snap.defaultRuntimeGeneration;
    this.defaultFenceEpoch = snap.defaultFenceEpoch;
    this.boundaryId = snap.boundaryId;
    this.lastEvidenceHash = snap.lastEvidenceHash;
    this.observe("sink.restore", {
      commitCount: this.commitCount,
      ledgerLen: this.ledger.length,
      observationLogLen: this.observationLog.length,
    });
  }

  private buildReceipt(req: AcceptRequest, outcome: EffectOutcome): EffectReceipt {
    const observedAt = this.clock();
    return {
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
  }

  private appendLedger(receipt: EffectReceipt): EffectReceipt {
    const sealed = { ...receipt };
    this.ledger.push(sealed);
    this.lastEvidenceHash = hash_receipt(this.lastEvidenceHash, sealed);
    if (sealed.outcome === "committed") {
      this.commitCount += 1;
      this.committedIds.set(sealed.effectId, sealed);
    }
    this.observe("sink.ledger_append", {
      effectId: sealed.effectId,
      outcome: sealed.outcome,
      commitCount: this.commitCount,
    });
    return sealed;
  }

  /**
   * Accept an effect at the boundary. Honors fault injection modes.
   * Idempotent: same effectId+actionDigest commit returns prior receipt (resend-safe).
   */
  async accept(req: AcceptRequest): Promise<AcceptResult> {
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
        const rejected = this.appendLedger(this.buildReceipt(req, "rejected"));
        return {
          accepted: false,
          receipt: rejected,
          reason: "effectId reuse with different actionDigest",
        };
      }
      this.observe("sink.resend_hit", { effectId: req.effectId });
      if (this.faultMode === "lost_reply") {
        return { accepted: true, receipt: null, suppressed: true, resent: true };
      }
      return { accepted: true, receipt: { ...prior }, resent: true };
    }

    if (this.faultMode === "timeout") {
      this.observe("sink.timeout", { effectId: req.effectId });
      return { accepted: false, receipt: null, reason: "injected timeout" };
    }

    if (this.faultMode === "delay" && this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }

    const outcome: EffectOutcome = req.forceOutcome ?? "committed";
    const receipt = this.appendLedger(this.buildReceipt(req, outcome));

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

    return {
      accepted: outcome === "committed" || outcome === "rejected" || outcome === "failed",
      receipt,
    };
  }
}
