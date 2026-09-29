/** Minimal EffectReceipt fields from Session Authority Profile v0.2. */
export type EffectOutcome = "committed" | "rejected" | "failed" | "unknown";

export interface EffectReceipt {
  effectId: string;
  actionDigest: string;
  runtimeGeneration: number;
  fenceEpoch: number;
  boundaryId: string;
  outcome: EffectOutcome;
  externalReference: string | null;
  observedAt: string;
  previousEvidenceHash: string | null;
  signature?: string;
  /** Controller that submitted this record (when known). */
  controller?: string;
  /** Lease / action scope (when known). */
  scopeId?: string;
  /** Approval id recorded on commit / grant (wire: approval_id). */
  approvalId?: string;
  /** Approval decision when present (wire: approval_decision). */
  approvalDecision?: "grant" | "deny" | "none";
  /** Generation when the referenced approval was issued (wire: approval_runtime_generation). */
  approvalRuntimeGeneration?: number;
}

export type FaultMode = "none" | "timeout" | "resend" | "lost_reply" | "delay";

/** Optional approval binding carried on AcceptRequest when enforce is on. */
export interface ApprovalBinding {
  approval_id: string;
  action_digest: string;
  runtime_generation: number;
  decision: "grant" | "deny" | "none";
}

export interface AcceptRequest {
  effectId: string;
  actionDigest: string;
  runtimeGeneration?: number;
  fenceEpoch?: number;
  boundaryId?: string;
  controller?: string;
  scopeId?: string;
  /** Optional explicit outcome override for tests. */
  forceOutcome?: EffectOutcome;
  /** Approval binding; required when sink enforce=true. */
  approval?: ApprovalBinding;
}

export interface AcceptResult {
  accepted: boolean;
  receipt: EffectReceipt | null;
  reason?: string;
  /** When faultMode=lost_reply, receipt is computed but not returned. */
  suppressed?: boolean;
  /** Duplicate of prior committed receipt on resend. */
  resent?: boolean;
}

export interface GrantRequest {
  effectId: string;
  actionDigest: string;
  approvalId: string;
  decision?: "grant" | "deny";
  runtimeGeneration?: number;
  fenceEpoch?: number;
  boundaryId?: string;
  controller?: string;
  scopeId?: string;
}

/** Advance fence / generation / holder. Values may only stay or increase. */
export interface FenceRequest {
  fenceEpoch?: number;
  runtimeGeneration?: number;
  scopeId?: string;
  holder?: string;
}

export interface FenceResult {
  ok: boolean;
  reason?: string;
  fenceEpoch: number;
  runtimeGeneration: number;
  holders: Record<string, string>;
}

export interface SinkSnapshot {
  commitCount: number;
  ledger: EffectReceipt[];
  pending: Record<string, EffectReceipt>;
  faultMode: FaultMode;
  delayMs: number;
  defaultRuntimeGeneration: number;
  defaultFenceEpoch: number;
  boundaryId: string;
  lastEvidenceHash: string | null;
  enforce?: boolean;
  holders?: Record<string, string>;
}

export interface ObservationEntry {
  at: string;
  type: string;
  detail: Record<string, unknown>;
}

/** Wire format asa.agent-effect/0.1 (snake_case). */
export interface AgentEffectRecord {
  schema_version: "asa.agent-effect/0.1";
  effect_id: string;
  action_digest: string;
  runtime_generation: number;
  fence_epoch: number;
  boundary_id: string;
  outcome: EffectOutcome;
  stream_id: string;
  sequence_number: number;
  ts_unix_nano: string;
  external_reference?: string | null;
  ts?: string;
  controller?: string;
  scope_id?: string;
  approval_decision?: "grant" | "deny" | "none";
  approval_id?: string;
  approval_runtime_generation?: number;
  previous_evidence_hash?: string | null;
  signature?: string;
}
