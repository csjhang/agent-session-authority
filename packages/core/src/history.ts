import fs from "node:fs";
export type EventKind = "invoke" | "ok" | "fail" | "info" | "observe" | "fault";

export type OpName =
  | "lease.acquire" | "lease.renew" | "lease.release" | "lease.revoke"
  | "generation.observe"
  | "action.propose" | "action.bind"
  | "approval.request" | "approval.grant" | "approval.deny" | "approval.record"
  | "effect.dispatch" | "effect.receipt" | "effect.query"
  | "session.attach" | "session.detach"
  | "control.handoff"
  | string;

export type FaultName =
  | "runtime.restart" | "runtime.crash"
  | "state.restore"
  | "net.partition" | "net.drop" | "net.delay"
  | "client.disconnect"
  | "message.duplicate"
  | "clock.skew"
  | string;

export interface HistoryEvent {
  seq: number;
  ts?: string;
  kind: EventKind;
  op?: OpName;
  fault?: FaultName;
  session_id?: string;
  actor_id?: string;
  invoke_seq?: number;
  attrs?: Record<string, unknown>;
  note?: string;
}

export interface ControlLease {
  scope_id: string;
  holder: string;
  issued_at?: string;
  expires_at?: string;
  fence_epoch: number;
}

export interface RuntimeGeneration {
  value: number;
  issuer_id?: string;
  runtime_id?: string;
  model?: "G0" | "G1" | "G2";
}

export interface ActionBinding {
  action_type: string;
  target: string;
  args?: unknown;
  policy_version?: string;
  runtime_generation?: number;
  nonce?: string;
  expiry?: string;
  scope_id?: string;
  action_digest?: string;
}

export interface ActionDigest {
  digest: string;
  binding?: ActionBinding;
}

export interface ApprovalDecision {
  approver: string;
  action_digest: string;
  decision: "grant" | "deny";
  policy?: string;
  issued_at?: string;
  expires_at?: string;
}

export interface FenceToken {
  fence_epoch: number;
  token?: string;
}

export type FenceEpoch = number;

export interface EffectId {
  effect_id: string;
}

export interface EffectReceipt {
  effect_id: string;
  action_digest?: string;
  runtime_generation?: number;
  fence_epoch?: number;
  boundary_id?: string;
  outcome: "committed" | "rejected" | "failed" | "unknown";
  external_reference?: string;
  observed_at?: string;
  previous_evidence_hash?: string;
  signature?: string;
}

export function parse_history_jsonl(text: string): HistoryEvent[] {
  const events: HistoryEvent[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line || line.startsWith("#")) continue;
    let obj: unknown;
    try { obj = JSON.parse(line); } catch (err) {
      throw new Error(`history JSONL parse error at line ${i + 1}: ${String(err)}`);
    }
    if (!obj || typeof obj !== "object") {
      throw new Error(`history JSONL non-object at line ${i + 1}`);
    }
    const ev = obj as HistoryEvent;
    if (typeof ev.seq !== "number") {
      throw new Error(`history JSONL missing seq at line ${i + 1}`);
    }
    if (typeof ev.kind !== "string") {
      throw new Error(`history JSONL missing kind at line ${i + 1}`);
    }
    events.push(ev);
  }
  events.sort((a, b) => a.seq - b.seq);
  return events;
}

export function load_history_file(path: string): HistoryEvent[] {
  return parse_history_jsonl(fs.readFileSync(path, "utf8"));
}
