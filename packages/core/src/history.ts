import fs from "node:fs";

export type EventKind = "invoke" | "ok" | "fail" | "info" | "observe" | "fault";

export const EVENT_KINDS: readonly EventKind[] = [
  "invoke",
  "ok",
  "fail",
  "info",
  "observe",
  "fault",
] as const;

/** Known op vocabulary. Unknown ops are allowed with a warning (extension policy). */
export const KNOWN_OPS = [
  "lease.acquire",
  "lease.renew",
  "lease.release",
  "lease.revoke",
  "generation.observe",
  "action.propose",
  "action.bind",
  "approval.request",
  "approval.grant",
  "approval.deny",
  "approval.record",
  "effect.dispatch",
  "effect.receipt",
  "effect.query",
  "effect.cancel",
  "effect.reconcile",
  "session.attach",
  "session.detach",
  "control.handoff",
  "task.cancel",
  "task.complete",
  "task.timeout",
  "task.reconcile",
] as const;

export type KnownOpName = (typeof KNOWN_OPS)[number];
export type OpName = KnownOpName | (string & {});

/** Known fault vocabulary. Unknown faults are allowed with a warning. */
export const KNOWN_FAULTS = [
  "runtime.restart",
  "runtime.crash",
  "state.restore",
  "net.partition",
  "net.drop",
  "net.delay",
  "client.disconnect",
  "message.duplicate",
  "clock.skew",
] as const;

export type KnownFaultName = (typeof KNOWN_FAULTS)[number];
export type FaultName = KnownFaultName | (string & {});

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

export interface ParseHistoryOptions {
  /** When true (default), unknown op/fault names emit warnings to `warn`. */
  warn_unknown_vocab?: boolean;
  /** Warning sink; defaults to console.warn. */
  warn?: (message: string) => void;
}

export class HistoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryValidationError";
  }
}

const KIND_SET = new Set<string>(EVENT_KINDS);
const OP_SET = new Set<string>(KNOWN_OPS);
const FAULT_SET = new Set<string>(KNOWN_FAULTS);

function is_finite_number(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Validate a single parsed object as a HistoryEvent.
 * Rejects missing/invalid required fields and unknown kinds.
 * Unknown ops/faults are allowed (extension) but may warn.
 */
export function validate_history_event(
  obj: unknown,
  line_no: number,
  options: ParseHistoryOptions = {},
): HistoryEvent {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new HistoryValidationError(`history JSONL non-object at line ${line_no}`);
  }
  const raw = obj as Record<string, unknown>;

  if (!("seq" in raw)) {
    throw new HistoryValidationError(`history JSONL missing seq at line ${line_no}`);
  }
  if (!is_finite_number(raw.seq)) {
    throw new HistoryValidationError(
      `history JSONL seq must be a finite number at line ${line_no}`,
    );
  }

  if (!("kind" in raw) || typeof raw.kind !== "string") {
    throw new HistoryValidationError(`history JSONL missing kind at line ${line_no}`);
  }
  if (!KIND_SET.has(raw.kind)) {
    throw new HistoryValidationError(
      `history JSONL invalid kind "${raw.kind}" at line ${line_no}; expected one of: ${EVENT_KINDS.join(", ")}`,
    );
  }

  const warn_unknown = options.warn_unknown_vocab !== false;
  const warn = options.warn ?? ((m: string) => console.warn(m));

  if ("op" in raw && raw.op !== undefined && raw.op !== null) {
    if (typeof raw.op !== "string") {
      throw new HistoryValidationError(`history JSONL op must be a string at line ${line_no}`);
    }
    if (warn_unknown && !OP_SET.has(raw.op)) {
      warn(
        `history JSONL unknown op "${raw.op}" at line ${line_no} (allowed as extension; not in known vocab)`,
      );
    }
  }

  if ("fault" in raw && raw.fault !== undefined && raw.fault !== null) {
    if (typeof raw.fault !== "string") {
      throw new HistoryValidationError(`history JSONL fault must be a string at line ${line_no}`);
    }
    if (warn_unknown && !FAULT_SET.has(raw.fault)) {
      warn(
        `history JSONL unknown fault "${raw.fault}" at line ${line_no} (allowed as extension; not in known vocab)`,
      );
    }
  }

  if ("invoke_seq" in raw && raw.invoke_seq !== undefined && raw.invoke_seq !== null) {
    if (!is_finite_number(raw.invoke_seq)) {
      throw new HistoryValidationError(
        `history JSONL invoke_seq must be a finite number at line ${line_no}`,
      );
    }
  }

  if ("attrs" in raw && raw.attrs !== undefined && raw.attrs !== null) {
    if (typeof raw.attrs !== "object" || Array.isArray(raw.attrs)) {
      throw new HistoryValidationError(
        `history JSONL attrs must be an object at line ${line_no}`,
      );
    }
  }

  return raw as unknown as HistoryEvent;
}

/**
 * Assert events are in strictly increasing seq order with no duplicates.
 * Does NOT sort — out-of-order or duplicate seq is a hard error.
 */
export function assert_seq_monotonic(events: HistoryEvent[]): void {
  let prev: number | undefined;
  for (let i = 0; i < events.length; i++) {
    const seq = events[i]!.seq;
    if (prev !== undefined) {
      if (seq === prev) {
        throw new HistoryValidationError(
          `history JSONL duplicate seq ${seq} at event index ${i} (line order preserved; sorting is not applied)`,
        );
      }
      if (seq < prev) {
        throw new HistoryValidationError(
          `history JSONL non-monotonic seq at event index ${i}: ${seq} follows ${prev} (sorting is not applied; fix the log)`,
        );
      }
    }
    prev = seq;
  }
}

/**
 * Parse history JSONL text into validated events.
 * Rejects bad JSON, missing/invalid fields, unknown kinds, and non-monotonic/duplicate seq.
 * Does not silently sort — order bugs stay visible.
 */
export function parse_history_jsonl(
  text: string,
  options: ParseHistoryOptions = {},
): HistoryEvent[] {
  const events: HistoryEvent[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line || line.startsWith("#")) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      throw new HistoryValidationError(
        `history JSONL parse error at line ${i + 1}: ${String(err)}`,
      );
    }
    events.push(validate_history_event(obj, i + 1, options));
  }
  assert_seq_monotonic(events);
  return events;
}

export function load_history_file(
  path: string,
  options: ParseHistoryOptions = {},
): HistoryEvent[] {
  return parse_history_jsonl(fs.readFileSync(path, "utf8"), options);
}

/** Serialize events to JSONL (one object per line, trailing newline). */
export function serialize_history_jsonl(events: HistoryEvent[]): string {
  if (events.length === 0) return "";
  return events.map((ev) => JSON.stringify(ev)).join("\n") + "\n";
}

/** Write events to a JSONL file after validating seq monotonicity. */
export function write_history_file(path: string, events: HistoryEvent[]): void {
  assert_seq_monotonic(events);
  for (let i = 0; i < events.length; i++) {
    validate_history_event(events[i], i + 1, { warn_unknown_vocab: false });
  }
  fs.writeFileSync(path, serialize_history_jsonl(events), "utf8");
}
