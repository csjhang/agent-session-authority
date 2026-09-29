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
  IssuedGrant,
  ObservationEntry,
  SinkSnapshot,
} from "./types.js";

function now_iso(): string {
  return new Date().toISOString();
}

/** Keys excluded from record-hash hashed form (link/co-sign fields stay out). */
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

/**
 * Record hash = sha256(JCS(form excluding previousEvidenceHash/signature/integrity*)).
 * Independent of key order and of chain link fields.
 */
export function hash_receipt(receipt: EffectReceipt): string {
  const h = createHash("sha256");
  h.update(canonicalize(strip_for_hash(receipt)));
  return h.digest("hex");
}

/**
 * Chain hash = sha256(previous_chain_hash || record_hash) over UTF-8 bytes.
 * First previous is the empty string.
 */
export function chain_hash(previousChainHash: string, recordHash: string): string {
  const h = createHash("sha256");
  h.update(previousChainHash, "utf8");
  h.update(recordHash, "utf8");
  return h.digest("hex");
}

export interface VerifyChainResult {
  ok: boolean;
  /** 0-based index of first broken link when ok=false. */
  breakAt?: number;
  /** Final chain hash after a full walk (even when ok=false, hash of prefix through break). */
  finalChainHash: string | null;
  reason?: string;
}

/**
 * Recompute the evidence chain from the start; report the first break.
 * previousEvidenceHash on receipt i must equal the chain hash of receipt i-1
 * (null/absent on the first record; formula uses "" for the first previous).
 *
 * When `expectedHead` is passed (including `null`), the final chain hash must
 * equal it or the result is ok=false with reason=head_mismatch. Omitting the
 * argument skips the head check (unkeyed chain can be fully rewritten).
 */
export function verify_chain(
  ledger: readonly EffectReceipt[],
  expectedHead?: string | null,
): VerifyChainResult {
  let prevChain = "";
  let lastComputed: string | null = null;
  for (let i = 0; i < ledger.length; i++) {
    const rec = ledger[i]!;
    const expectedPrev = prevChain === "" ? null : prevChain;
    const gotPrev = rec.previousEvidenceHash ?? null;
    if (gotPrev !== expectedPrev) {
      return {
        ok: false,
        breakAt: i,
        finalChainHash: lastComputed,
        reason: `previousEvidenceHash mismatch at ${i}`,
      };
    }
    const rh = hash_receipt(rec);
    const ch = chain_hash(prevChain, rh);
    lastComputed = ch;
    prevChain = ch;
  }
  if (expectedHead !== undefined) {
    const head = expectedHead ?? null;
    if (lastComputed !== head) {
      return {
        ok: false,
        finalChainHash: lastComputed,
        reason: "head_mismatch",
      };
    }
  }
  return { ok: true, finalChainHash: lastComputed };
}


/**
 * Integrity hash over the full SinkSnapshot (JCS). Used under enforce so restore
 * rejects snaps whose holders/fence/generation/ledger/etc. were altered after
 * snapshot() — not only lastEvidenceHash mismatches.
 */
export function snapshot_integrity_hash(snap: SinkSnapshot): string {
  const h = createHash("sha256");
  h.update(canonicalize(snap as unknown as Record<string, unknown>));
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
 *
 * Fence/holder policy (enforce): changing a scope holder via fence() auto-increments
 * fenceEpoch when the request does not already raise it.
 *
 * restore() policy: if snapshot.enforce !== this instance's enforce flag → throw
 * (does not apply a mismatched snapshot). Also verifies the ledger chain and that
 * snap.lastEvidenceHash matches the recomputed head (else chain_invalid). Under
 * enforce, only snapshots this instance produced (via snapshot()) are accepted —
 * integrity is sha256(JCS(full snapshot)) (else unknown_snapshot). Under enforce,
 * restore must not rewind fencing (AUTH-01b): runtimeGeneration and fenceEpoch
 * become max(current, snap)+1; holders stay at CURRENT (snap holders ignored);
 * observes sink.restore_bump.
 */
export class MockEffectSink {
  private commitCount = 0;
  private ledger: EffectReceipt[] = [];
  private pending = new Map<string, EffectReceipt>();
  private committedIds = new Map<string, EffectReceipt>();
  /** approval_id → effectId that committed with it. */
  private usedApprovals = new Map<string, string>();
  /**
   * approval_id → effectId reserved before await (released if no commit).
   * After approval↔effect binding (issued.effectId must match req.effectId),
   * cross-effect races fail at approval_effect_mismatch before reserve, so this
   * map rarely fires under enforce. Kept for defense-in-depth if binding is
   * ever relaxed and for the claim-before-await pattern with delay-mode.
   */
  private reservedApprovals = new Map<string, string>();
  /** approval_id → full grant() history (latest wins). */
  private grantHistory = new Map<string, IssuedGrant[]>();
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
  /**
   * sha256(JCS(full snapshot)) values this instance has emitted via snapshot().
   * Used under enforce to reject foreign or tampered snapshots (covers holders,
   * fence/generation, ledger, pending — not only lastEvidenceHash).
   */
  private readonly knownSnapshotHashes = new Set<string>();

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

  getLastEvidenceHash(): string | null {
    return this.lastEvidenceHash;
  }

  /** Latest issued grant for approval_id, if any. */
  getLatestGrant(approvalId: string): IssuedGrant | undefined {
    const hist = this.grantHistory.get(approvalId);
    if (!hist || hist.length === 0) return undefined;
    return hist[hist.length - 1];
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
      if (r.recordKind !== undefined) rec.record_kind = r.recordKind;
      return rec;
    });
  }

  snapshot(): SinkSnapshot {
    const snap: SinkSnapshot = {
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
    this.knownSnapshotHashes.add(snapshot_integrity_hash(snap));
    return snap;
  }

  /**
   * Restore sink state. Observation log is preserved (not rolled back).
   * Throws if snapshot.enforce !== this.enforce (restore policy: hard error).
   * Throws chain_invalid if verify_chain fails or lastEvidenceHash ≠ recomputed head
   * (does not apply). Under enforce, throws unknown_snapshot if sha256(JCS(snap))
   * was never produced by this instance via snapshot(). Under enforce, fencing is
   * not rewound (AUTH-01b): gen/epoch = max(current, snap)+1; holders keep CURRENT.
   */
  restore(snap: SinkSnapshot): void {
    const snapEnforce = snap.enforce ?? false;
    if (snapEnforce !== this.enforce) {
      const msg = `restore enforce mismatch: snapshot=${snapEnforce} instance=${this.enforce}`;
      this.observe("sink.restore_reject", {
        reason: "enforce_mismatch",
        snapshotEnforce: snapEnforce,
        instanceEnforce: this.enforce,
      });
      throw new Error(msg);
    }

    const chain = verify_chain(snap.ledger, snap.lastEvidenceHash ?? null);
    if (!chain.ok) {
      this.observe("sink.restore_reject", {
        reason: "chain_invalid",
        detail: chain.reason,
        breakAt: chain.breakAt ?? null,
        finalChainHash: chain.finalChainHash,
        snapshotHead: snap.lastEvidenceHash,
      });
      throw new Error(`restore chain_invalid: ${chain.reason ?? "verify_chain failed"}`);
    }

    if (this.enforce) {
      const key = snapshot_integrity_hash(snap);
      if (!this.knownSnapshotHashes.has(key)) {
        this.observe("sink.restore_reject", {
          reason: "unknown_snapshot",
          snapshotIntegrityHash: key,
          snapshotHead: snap.lastEvidenceHash,
        });
        throw new Error("restore unknown_snapshot: snapshot not produced by this sink");
      }
    }

    // Capture pre-restore fencing/holders before applying snap (enforce bump).
    const prevGen = this.defaultRuntimeGeneration;
    const prevEpoch = this.defaultFenceEpoch;
    const prevHolders = new Map(this.holders);

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
    this.reservedApprovals.clear();
    this.rebuildGrantHistoryFromLedger();
    this.faultMode = snap.faultMode;
    this.delayMs = snap.delayMs;
    this.boundaryId = snap.boundaryId;
    this.lastEvidenceHash = snap.lastEvidenceHash;

    if (this.enforce) {
      // AUTH-01b: generation/fence strictly increase after restore; holders stay current.
      const bumpedGen = Math.max(prevGen, snap.defaultRuntimeGeneration) + 1;
      const bumpedEpoch = Math.max(prevEpoch, snap.defaultFenceEpoch) + 1;
      this.defaultRuntimeGeneration = bumpedGen;
      this.defaultFenceEpoch = bumpedEpoch;
      this.holders.clear();
      for (const [k, v] of prevHolders) this.holders.set(k, v);
      this.observe("sink.restore_bump", {
        prevRuntimeGeneration: prevGen,
        prevFenceEpoch: prevEpoch,
        snapRuntimeGeneration: snap.defaultRuntimeGeneration,
        snapFenceEpoch: snap.defaultFenceEpoch,
        runtimeGeneration: bumpedGen,
        fenceEpoch: bumpedEpoch,
        holders: this.getHolders(),
      });
    } else {
      this.defaultRuntimeGeneration = snap.defaultRuntimeGeneration;
      this.defaultFenceEpoch = snap.defaultFenceEpoch;
      this.holders.clear();
      if (snap.holders) {
        for (const [k, v] of Object.entries(snap.holders)) this.holders.set(k, v);
      }
    }

    this.observe("sink.restore", {
      commitCount: this.commitCount,
      ledgerLen: this.ledger.length,
      observationLogLen: this.observationLog.length,
      runtimeGeneration: this.defaultRuntimeGeneration,
      fenceEpoch: this.defaultFenceEpoch,
    });
  }

  private rebuildGrantHistoryFromLedger(): void {
    this.grantHistory.clear();
    for (const r of this.ledger) {
      if (r.recordKind !== "approval") continue;
      if (!r.approvalId || (r.approvalDecision !== "grant" && r.approvalDecision !== "deny")) {
        continue;
      }
      const issued: IssuedGrant = {
        approvalId: r.approvalId,
        effectId: r.effectId,
        actionDigest: r.actionDigest,
        decision: r.approvalDecision,
        runtimeGeneration: r.approvalRuntimeGeneration ?? r.runtimeGeneration,
        fenceEpoch: r.fenceEpoch,
        observedAt: r.observedAt,
      };
      const list = this.grantHistory.get(r.approvalId) ?? [];
      list.push(issued);
      this.grantHistory.set(r.approvalId, list);
    }
  }

  /**
   * Advance fenceEpoch, runtimeGeneration, and/or change a scope's holder.
   * Validates all fields first; applies only if every check passes (atomic).
   *
   * When enforce=true and holder changes: auto-increment fenceEpoch unless the
   * request already sets a strictly larger fenceEpoch.
   */
  fence(req: FenceRequest): FenceResult {
    const curFence = this.defaultFenceEpoch;
    const curGen = this.defaultRuntimeGeneration;

    if (typeof req.fenceEpoch === "number" && req.fenceEpoch < curFence) {
      this.observe("sink.fence_reject", {
        reason: "fence_decrement",
        requested: req.fenceEpoch,
        current: curFence,
      });
      return {
        ok: false,
        reason: "fence_decrement",
        fenceEpoch: curFence,
        runtimeGeneration: curGen,
        holders: this.getHolders(),
      };
    }
    if (typeof req.runtimeGeneration === "number" && req.runtimeGeneration < curGen) {
      this.observe("sink.fence_reject", {
        reason: "generation_decrement",
        requested: req.runtimeGeneration,
        current: curGen,
      });
      return {
        ok: false,
        reason: "generation_decrement",
        fenceEpoch: curFence,
        runtimeGeneration: curGen,
        holders: this.getHolders(),
      };
    }

    // All checks passed — apply.
    if (typeof req.fenceEpoch === "number") {
      this.defaultFenceEpoch = req.fenceEpoch;
    }
    if (typeof req.runtimeGeneration === "number") {
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
      // Enforce policy: holder change auto-increments fenceEpoch when request
      // did not already raise it above the pre-request value.
      if (this.enforce) {
        const raisedInRequest =
          typeof req.fenceEpoch === "number" && req.fenceEpoch > curFence;
        if (!raisedInRequest) {
          this.defaultFenceEpoch = Math.max(this.defaultFenceEpoch, curFence) + 1;
        }
      }
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
   * Record an approval grant/deny issuance (outcome=unknown, record_kind=approval)
   * for agent-effect export and enforce lookup.
   *
   * Under enforce: gen/fence are always the sink's current runtimeGeneration and
   * fenceEpoch. If the request carries different values → grant_generation_mismatch
   * / grant_fence_mismatch (no ledger write, no grantHistory).
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
    let runtimeGeneration: number;
    let fenceEpoch: number;
    if (this.enforce) {
      runtimeGeneration = this.defaultRuntimeGeneration;
      fenceEpoch = this.defaultFenceEpoch;
      if (
        typeof req.runtimeGeneration === "number" &&
        req.runtimeGeneration !== runtimeGeneration
      ) {
        this.observe("sink.grant_reject", {
          reason: "grant_generation_mismatch",
          requested: req.runtimeGeneration,
          current: runtimeGeneration,
        });
        return {
          accepted: false,
          receipt: null,
          reason: "grant_generation_mismatch",
        };
      }
      if (typeof req.fenceEpoch === "number" && req.fenceEpoch !== fenceEpoch) {
        this.observe("sink.grant_reject", {
          reason: "grant_fence_mismatch",
          requested: req.fenceEpoch,
          current: fenceEpoch,
        });
        return {
          accepted: false,
          receipt: null,
          reason: "grant_fence_mismatch",
        };
      }
    } else {
      runtimeGeneration = req.runtimeGeneration ?? this.defaultRuntimeGeneration;
      fenceEpoch = req.fenceEpoch ?? this.defaultFenceEpoch;
    }
    const receipt = this.appendLedger(
      this.buildReceipt(
        {
          effectId: req.effectId,
          actionDigest: req.actionDigest,
          runtimeGeneration,
          fenceEpoch,
          boundaryId: req.boundaryId,
          controller: req.controller,
          scopeId: req.scopeId,
        },
        "unknown",
        {
          approvalId: req.approvalId,
          approvalDecision: decision,
          approvalRuntimeGeneration: runtimeGeneration,
          recordKind: "approval",
        },
      ),
    );
    const issued: IssuedGrant = {
      approvalId: req.approvalId,
      effectId: req.effectId,
      actionDigest: req.actionDigest,
      decision,
      runtimeGeneration,
      fenceEpoch,
      observedAt: receipt.observedAt,
    };
    const hist = this.grantHistory.get(req.approvalId) ?? [];
    hist.push(issued);
    this.grantHistory.set(req.approvalId, hist);
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
      recordKind?: "effect" | "approval";
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
    if (approval?.recordKind !== undefined) receipt.recordKind = approval.recordKind;
    return receipt;
  }

  private appendLedger(receipt: EffectReceipt): EffectReceipt {
    const sealed = { ...receipt };
    this.ledger.push(sealed);
    const recordHash = hash_receipt(sealed);
    const prev = this.lastEvidenceHash ?? "";
    this.lastEvidenceHash = chain_hash(prev, recordHash);
    if (sealed.outcome === "committed") {
      this.commitCount += 1;
      this.committedIds.set(sealed.effectId, sealed);
      if (sealed.approvalId) {
        this.usedApprovals.set(sealed.approvalId, sealed.effectId);
        this.reservedApprovals.delete(sealed.approvalId);
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
    detail?: Record<string, unknown>,
  ): AcceptResult {
    const rejected = this.appendLedger(
      this.buildReceipt(req, "rejected", { ...approval, recordKind: "effect" }),
    );
    return { accepted: false, receipt: rejected, reason, ...(detail ? { detail } : {}) };
  }

  /**
   * Enforce checks. Returns a reject AcceptResult, or { reserveApprovalId } when
   * checks pass and an approval_id was reserved, or null when enforce is off.
   */
  private enforceChecks(
    req: AcceptRequest,
  ): AcceptResult | { ok: true; reserveApprovalId?: string } | null {
    if (!this.enforce) return null;

    const missing: string[] = [];
    if (typeof req.fenceEpoch !== "number") missing.push("fenceEpoch");
    if (typeof req.runtimeGeneration !== "number") missing.push("runtimeGeneration");
    if (typeof req.controller !== "string" || req.controller.length === 0) {
      missing.push("controller");
    }
    if (typeof req.scopeId !== "string" || req.scopeId.length === 0) {
      missing.push("scopeId");
    }
    if (missing.length > 0) {
      return this.reject(req, "missing_authority_fields", undefined, { missing });
    }

    const reqFence = req.fenceEpoch!;
    if (reqFence < this.defaultFenceEpoch) {
      return this.reject(req, "stale_fence");
    }

    const reqGen = req.runtimeGeneration!;
    if (reqGen !== this.defaultRuntimeGeneration) {
      return this.reject(req, "generation_mismatch");
    }

    const scopeId = req.scopeId!;
    if (!this.holders.has(scopeId)) {
      return this.reject(req, "unknown_scope");
    }
    const holder = this.holders.get(scopeId)!;
    if (req.controller !== holder) {
      return this.reject(req, "not_holder");
    }

    if (!req.approval || typeof req.approval.approval_id !== "string" || !req.approval.approval_id) {
      return this.reject(req, "missing_approval");
    }
    const approvalId = req.approval.approval_id;
    const issued = this.getLatestGrant(approvalId);
    if (!issued) {
      return this.reject(req, "unknown_approval", { approvalId });
    }
    if (issued.decision !== "grant") {
      return this.reject(req, "approval_denied", {
        approvalId,
        approvalDecision: issued.decision,
        approvalRuntimeGeneration: issued.runtimeGeneration,
      });
    }
    if (issued.effectId !== req.effectId) {
      return this.reject(req, "approval_effect_mismatch", {
        approvalId,
        approvalDecision: issued.decision,
        approvalRuntimeGeneration: issued.runtimeGeneration,
      });
    }
    if (issued.actionDigest !== req.actionDigest) {
      return this.reject(req, "approval_digest_mismatch", {
        approvalId,
        approvalDecision: issued.decision,
        approvalRuntimeGeneration: issued.runtimeGeneration,
      });
    }
    if (issued.runtimeGeneration !== this.defaultRuntimeGeneration) {
      return this.reject(req, "approval_generation_mismatch", {
        approvalId,
        approvalDecision: issued.decision,
        approvalRuntimeGeneration: issued.runtimeGeneration,
      });
    }
    const heldBy =
      this.usedApprovals.get(approvalId) ?? this.reservedApprovals.get(approvalId);
    if (heldBy !== undefined && heldBy !== req.effectId) {
      return this.reject(req, "approval_reused", {
        approvalId,
        approvalDecision: issued.decision,
        approvalRuntimeGeneration: issued.runtimeGeneration,
      });
    }

    // Reserve before any await (caller applies).
    return { ok: true, reserveApprovalId: approvalId };
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

  private releaseReservation(approvalId: string | undefined, effectId: string): void {
    if (!approvalId) return;
    if (this.reservedApprovals.get(approvalId) === effectId) {
      this.reservedApprovals.delete(approvalId);
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
    if (enforced && !("ok" in enforced && enforced.ok === true)) {
      return enforced as AcceptResult;
    }
    const reserveApprovalId =
      enforced && "ok" in enforced ? enforced.reserveApprovalId : undefined;
    if (reserveApprovalId) {
      this.reservedApprovals.set(reserveApprovalId, req.effectId);
    }

    try {
      if (this.faultMode === "timeout") {
        this.observe("sink.timeout", { effectId: req.effectId });
        this.releaseReservation(reserveApprovalId, req.effectId);
        return { accepted: false, receipt: null, reason: "injected timeout" };
      }

      if (this.faultMode === "delay" && this.delayMs > 0) {
        await new Promise((r) => setTimeout(r, this.delayMs));
      }

      // Re-check reservation lost to a concurrent winner (should not happen if
      // reserve was set atomically, but keep defensive).
      if (reserveApprovalId) {
        const holder =
          this.usedApprovals.get(reserveApprovalId) ??
          this.reservedApprovals.get(reserveApprovalId);
        if (holder !== undefined && holder !== req.effectId) {
          return this.reject(req, "approval_reused", {
            approvalId: reserveApprovalId,
          });
        }
      }

      const outcome: EffectOutcome = req.forceOutcome ?? "committed";
      const issued = reserveApprovalId ? this.getLatestGrant(reserveApprovalId) : undefined;
      const approvalMeta = reserveApprovalId
        ? {
            approvalId: reserveApprovalId,
            approvalDecision: (issued?.decision ?? "grant") as "grant" | "deny" | "none",
            approvalRuntimeGeneration: issued?.runtimeGeneration ?? this.defaultRuntimeGeneration,
            recordKind: "effect" as const,
          }
        : req.approval
          ? {
              approvalId: req.approval.approval_id,
              approvalDecision: req.approval.decision,
              approvalRuntimeGeneration: req.approval.runtime_generation,
              recordKind: "effect" as const,
            }
          : { recordKind: "effect" as const };
      const receipt = this.appendLedger(this.buildReceipt(req, outcome, approvalMeta));

      if (outcome !== "committed") {
        this.releaseReservation(reserveApprovalId, req.effectId);
      }

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
        accepted: outcome === "committed" || outcome === "failed",
        receipt,
        ...(outcome === "rejected" ? { reason: "outcome_rejected" } : {}),
      };
    } catch (e) {
      this.releaseReservation(reserveApprovalId, req.effectId);
      throw e;
    }
  }
}
