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
}

export type FaultMode = "none" | "timeout" | "resend" | "lost_reply" | "delay";

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
}

export interface ObservationEntry {
  at: string;
  type: string;
  detail: Record<string, unknown>;
}
