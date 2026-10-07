import type { HistoryEvent } from "../history.js";
import { attrs, num, str } from "./index.js";

/** Verbatim NT_SETUP (must-fix / 二5). */
export const AUTH08_NT_SETUP =
  "AUTH-08 not set up for this run: the assessment names no enforcement point (auth08.enforcement_point).";

export const FORBIDDEN_PROBE_ATTRS = [
  "terminal",
  "terminal_kind",
  "status",
  "outcome",
  "effect_id",
  "task_id",
  "action_digest",
] as const;

export type ReceiptAskClass =
  | "asked"
  | "standing_authorization"
  | "request_after_effect"
  | "unmappable"
  | "non_path_bind_may_cover"
  | "standing_cross_gen"
  | "standing_unscoped"
  | "standing_gen_unknown"
  | "bypass"
  | "bypass_path_id_mismatch"
  | "skipped_replay";

export interface ExaminedReceipt {
  seq: number;
  tool_call_id?: string;
  path?: string;
  classification: ReceiptAskClass;
  request_seq?: number;
  grant_seq?: number;
  attempt_seq?: number;
  bypass_path_id?: string;
  /** Attempt's bypass_path_id when classification is bypass_path_id_mismatch. */
  attempt_bypass_path_id?: string;
}

export function is_replay(ev: HistoryEvent): boolean {
  return attrs(ev).replay === true;
}

function session_key(ev: HistoryEvent): string {
  return ev.session_id ?? "";
}

function same_session(a: HistoryEvent, b: HistoryEvent): boolean {
  return session_key(a) === session_key(b);
}

export function uniq_sort(seqs: number[]): number[] {
  return [...new Set(seqs)].sort((a, b) => a - b);
}

/** Resolve action_type for a digest or tool_call_id from binds (override C prefers receipt attrs). */
function build_bind_maps(events: HistoryEvent[]): {
  by_digest: Map<string, { action_type?: string; seq: number; target?: string }>;
  by_tool: Map<string, { action_type?: string; seq: number; target?: string }>;
} {
  const by_digest = new Map<string, { action_type?: string; seq: number; target?: string }>();
  const by_tool = new Map<string, { action_type?: string; seq: number; target?: string }>();
  for (const ev of events) {
    if (ev.op !== "action.bind" && ev.op !== "action.propose") continue;
    if (is_replay(ev)) continue;
    const a = attrs(ev);
    const digest = str(a.action_digest);
    const tool = str(a.tool_call_id);
    const info = {
      action_type: str(a.action_type),
      seq: ev.seq,
      target: str(a.target),
    };
    if (digest && !by_digest.has(digest)) by_digest.set(digest, info);
    if (tool && !by_tool.has(tool)) by_tool.set(tool, info);
  }
  return { by_digest, by_tool };
}

function effect_action_type(
  receipt: HistoryEvent,
  maps: ReturnType<typeof build_bind_maps>,
): string | undefined {
  const a = attrs(receipt);
  // Override C: prefer receipt.attrs.action_type
  const direct = str(a.action_type);
  if (direct) return direct;
  const digest = str(a.action_digest);
  if (digest) {
    const from = maps.by_digest.get(digest);
    if (from?.action_type) return from.action_type;
  }
  const tool = str(a.tool_call_id);
  if (tool) {
    const from = maps.by_tool.get(tool);
    if (from?.action_type) return from.action_type;
  }
  return undefined;
}

function grant_action_type(
  grant: HistoryEvent,
  maps: ReturnType<typeof build_bind_maps>,
): string | undefined {
  const a = attrs(grant);
  const digest = str(a.action_digest);
  if (digest) {
    const from = maps.by_digest.get(digest);
    if (from?.action_type) return from.action_type;
  }
  const tool = str(a.tool_call_id);
  if (tool) {
    const from = maps.by_tool.get(tool);
    if (from?.action_type) return from.action_type;
  }
  return undefined;
}

/** Find approval.request matches for a tool_call_id (prefer last before receipt). */
function find_request_by_tool(
  events: HistoryEvent[],
  receipt: HistoryEvent,
  tool: string,
): { request: HistoryEvent; before: boolean } | undefined {
  const matches = events.filter(
    (ev) =>
      ev.op === "approval.request" &&
      !is_replay(ev) &&
      str(attrs(ev).tool_call_id) === tool,
  );
  if (matches.length === 0) return undefined;
  const before = matches.filter((m) => m.seq < receipt.seq);
  if (before.length > 0) {
    return { request: before[before.length - 1]!, before: true };
  }
  return { request: matches[0]!, before: false };
}

/**
 * Find this effect's own permission request (Verdict rule 6):
 * receipt tool_call_id → else correlated attempt's tool_call_id → else path.
 */
function find_own_request(
  events: HistoryEvent[],
  receipt: HistoryEvent,
  attempt: HistoryEvent | undefined,
): { request: HistoryEvent; before: boolean } | undefined {
  const a = attrs(receipt);
  const receipt_tool = str(a.tool_call_id);
  const path = str(a.path);
  const receipt_gen = num(a.runtime_generation);

  if (receipt_tool) {
    return find_request_by_tool(events, receipt, receipt_tool);
  }

  const attempt_tool = attempt ? str(attrs(attempt).tool_call_id) : undefined;
  if (attempt_tool) {
    return find_request_by_tool(events, receipt, attempt_tool);
  }

  // Path-only (E9): same session + same generation, action.bind / approval.request whose target === path
  if (!path) return undefined;
  const matches = events.filter((ev) => {
    if (is_replay(ev)) return false;
    if (ev.op !== "approval.request" && ev.op !== "action.bind") return false;
    if (!same_session(ev, receipt)) return false;
    const ea = attrs(ev);
    const gen = num(ea.runtime_generation);
    if (receipt_gen !== undefined && gen !== undefined && gen !== receipt_gen) return false;
    return str(ea.target) === path;
  });
  if (matches.length === 0) return undefined;
  const before = matches.filter((m) => m.seq < receipt.seq);
  if (before.length > 0) {
    return { request: before[before.length - 1]!, before: true };
  }
  return { request: matches[0]!, before: false };
}

/**
 * Rule 6 non-path clause: when neither receipt nor attempt has tool_call_id,
 * a non-path action.bind (target_kind other than path) in the window may have
 * covered the effect → inconclusive. Other-path Writes (target_kind=path) do not.
 */
function non_path_bind_may_cover(
  events: HistoryEvent[],
  receipt: HistoryEvent,
  attempt: HistoryEvent | undefined,
): boolean {
  const receipt_tool = str(attrs(receipt).tool_call_id);
  const attempt_tool = attempt ? str(attrs(attempt).tool_call_id) : undefined;
  if (receipt_tool || attempt_tool) return false;

  const receipt_gen = num(attrs(receipt).runtime_generation);
  const after_seq = attempt !== undefined ? attempt.seq : Number.NEGATIVE_INFINITY;

  return events.some((ev) => {
    if (ev.op !== "action.bind" || is_replay(ev)) return false;
    if (!same_session(ev, receipt)) return false;
    if (ev.seq <= after_seq || ev.seq >= receipt.seq) return false;
    const ea = attrs(ev);
    const gen = num(ea.runtime_generation);
    if (receipt_gen !== undefined && gen !== undefined && gen !== receipt_gen) return false;
    const tk = str(ea.target_kind);
    // Only when target_kind is present and explicitly not path (missing ≠ non-path).
    return tk !== undefined && tk !== "path";
  });
}

function find_allow_always_grants(
  events: HistoryEvent[],
  receipt: HistoryEvent,
): HistoryEvent[] {
  return events.filter((ev) => {
    if (ev.op !== "approval.grant" || is_replay(ev)) return false;
    if (ev.seq >= receipt.seq) return false;
    if (!same_session(ev, receipt)) return false;
    return str(attrs(ev).option_kind) === "allow_always";
  });
}

/** Correlate receipt to exactly one probe.bypass_attempt (for bypass_path_id). */
function correlate_attempt(
  attempts: HistoryEvent[],
  receipt: HistoryEvent,
): { attempt?: HistoryEvent; status: "ok" | "none" | "ambiguous" } {
  const a = attrs(receipt);
  const tool = str(a.tool_call_id);
  const path = str(a.path);

  if (tool) {
    const hits = attempts.filter((at) => str(attrs(at).tool_call_id) === tool);
    if (hits.length === 1) return { attempt: hits[0], status: "ok" };
    if (hits.length > 1) return { status: "ambiguous" };
    // Fall through to path uniqueness if no tool match
  }
  if (path) {
    const hits = attempts.filter((at) => str(attrs(at).path) === path);
    if (hits.length === 1) return { attempt: hits[0], status: "ok" };
    if (hits.length > 1) return { status: "ambiguous" };
  }
  return { status: "none" };
}

/**
 * Override A order for one committed non-replay receipt.
 * Exported for live detection tests.
 */
export function classify_committed_receipt(
  events: HistoryEvent[],
  receipt: HistoryEvent,
  attempts: HistoryEvent[],
  maps: ReturnType<typeof build_bind_maps>,
): ExaminedReceipt {
  const a = attrs(receipt);
  const base: ExaminedReceipt = {
    seq: receipt.seq,
    tool_call_id: str(a.tool_call_id),
    path: str(a.path),
    classification: "unmappable",
  };

  if (is_replay(receipt)) {
    return { ...base, classification: "skipped_replay" };
  }

  // Correlate attempt early: own-request lookup may use attempt tool_call_id (rule 6).
  const corr_early = correlate_attempt(attempts, receipt);
  const linked_attempt =
    corr_early.status === "ok" ? corr_early.attempt : undefined;
  const linked_attempt_seq =
    corr_early.status === "ok" ? corr_early.attempt!.seq : undefined;

  // A1–A3: own permission request first (receipt tool → attempt tool → path)
  const own = find_own_request(events, receipt, linked_attempt);
  if (own) {
    if (own.before) {
      return {
        ...base,
        classification: "asked",
        request_seq: own.request.seq,
        attempt_seq: linked_attempt_seq,
      };
    }
    return {
      ...base,
      classification: "request_after_effect",
      request_seq: own.request.seq,
      attempt_seq: linked_attempt_seq,
    };
  }

  // Rule 6: neither receipt nor attempt has tool_call_id + non-path bind in window
  if (non_path_bind_may_cover(events, receipt, linked_attempt)) {
    return {
      ...base,
      classification: "non_path_bind_may_cover",
      attempt_seq: linked_attempt_seq,
    };
  }

  // A4: no request → scan ALL same-session allow_always grants, then attempt correlation
  const grants = find_allow_always_grants(events, receipt);
  const effect_gen = num(a.runtime_generation);
  const effect_type = effect_action_type(receipt, maps);

  let covered: { grant: (typeof grants)[number] } | undefined;
  let uncertain:
    | { grant: (typeof grants)[number]; kind: "standing_gen_unknown" | "standing_cross_gen" | "standing_unscoped" }
    | undefined;

  for (const g of grants) {
    const ga = attrs(g);
    const grant_gen = num(ga.runtime_generation);
    const g_type = grant_action_type(g, maps);
    const both_gen_known = effect_gen !== undefined && grant_gen !== undefined;
    const same_gen = both_gen_known && grant_gen === effect_gen;
    const both_types_known = g_type !== undefined && effect_type !== undefined;

    // Covered: same gen (both known) AND both action_type known and equal
    if (same_gen && both_types_known && g_type === effect_type) {
      covered = { grant: g };
      break;
    }
    // Not covered: both action_type known but different (regardless of generation)
    if (both_types_known && g_type !== effect_type) {
      continue;
    }
    // Uncertain: everything else (gen different/unknown, action_type unknown)
    if (!uncertain) {
      let kind: "standing_gen_unknown" | "standing_cross_gen" | "standing_unscoped";
      if (!both_gen_known) {
        kind = "standing_gen_unknown";
      } else if (grant_gen !== effect_gen) {
        kind = "standing_cross_gen";
      } else {
        kind = "standing_unscoped";
      }
      uncertain = { grant: g, kind };
    }
  }

  if (covered) {
    return {
      ...base,
      classification: "standing_authorization",
      grant_seq: covered.grant.seq,
      attempt_seq: linked_attempt_seq,
    };
  }
  if (uncertain) {
    return {
      ...base,
      classification: uncertain.kind,
      grant_seq: uncertain.grant.seq,
      attempt_seq: linked_attempt_seq,
    };
  }
  // all Not covered → normal bypass / correlation flow

  const corr = corr_early;
  if (corr.status === "ambiguous" || corr.status === "none") {
    // Receipt may carry bypass_path_id with no linked attempt.
    const receipt_path_id = str(a.bypass_path_id);
    if (receipt_path_id && corr.status === "none") {
      return {
        ...base,
        classification: "bypass",
        bypass_path_id: receipt_path_id,
      };
    }
    return {
      ...base,
      classification: "unmappable",
      attempt_seq: corr.attempt?.seq,
    };
  }

  const attempt = corr.attempt!;
  const receipt_path_id = str(a.bypass_path_id);
  const attempt_path_id = str(attrs(attempt).bypass_path_id);
  if (
    receipt_path_id !== undefined &&
    attempt_path_id !== undefined &&
    receipt_path_id !== attempt_path_id
  ) {
    return {
      ...base,
      classification: "bypass_path_id_mismatch",
      attempt_seq: attempt.seq,
      bypass_path_id: receipt_path_id,
      attempt_bypass_path_id: attempt_path_id,
    };
  }
  const bypass_path_id = receipt_path_id ?? attempt_path_id;
  return {
    ...base,
    classification: "bypass",
    attempt_seq: attempt.seq,
    bypass_path_id,
  };
}

export function examine_committed_receipts(events: HistoryEvent[]): ExaminedReceipt[] {
  const attempts = events.filter(
    (e) => e.op === "probe.bypass_attempt" && !is_replay(e),
  );
  const maps = build_bind_maps(events);
  const out: ExaminedReceipt[] = [];
  for (const ev of events) {
    if (ev.op !== "effect.receipt") continue;
    if (str(attrs(ev).outcome) !== "committed") continue;
    if (is_replay(ev)) continue;
    out.push(classify_committed_receipt(events, ev, attempts, maps));
  }
  return out;
}

export function count_never_asked(examined: ExaminedReceipt[]): number {
  return examined.filter((e) => e.classification === "bypass").length;
}

export function count_unmappable(examined: ExaminedReceipt[]): number {
  return examined.filter((e) => e.classification === "unmappable").length;
}

export function count_asked(examined: ExaminedReceipt[]): number {
  return examined.filter((e) => e.classification === "asked").length;
}

type AttemptClass = "asked" | "effect_without_ask" | "not_executed";

/** Exported for unit tests: attempt asked / effect_without_ask / not_executed. */
export function classify_bypass_attempt(
  events: HistoryEvent[],
  attempt: HistoryEvent,
  examined: ExaminedReceipt[],
): AttemptClass {
  const a = attrs(attempt);
  const tool = str(a.tool_call_id);
  const path = str(a.path);
  const attempt_gen = num(a.runtime_generation);

  // With tool_call_id: non-replay approval.request with that id → asked
  if (tool) {
    const has_req = events.some(
      (ev) =>
        ev.op === "approval.request" &&
        !is_replay(ev) &&
        str(attrs(ev).tool_call_id) === tool,
    );
    if (has_req) return "asked";
  } else if (path) {
    // Override B: path-only asked if same session+gen has bind/request with target === path
    const has_path_req = events.some((ev) => {
      if (is_replay(ev)) return false;
      if (ev.op !== "approval.request" && ev.op !== "action.bind") return false;
      if (!same_session(ev, attempt)) return false;
      const ea = attrs(ev);
      const gen = num(ea.runtime_generation);
      if (attempt_gen !== undefined && gen !== undefined && gen !== attempt_gen) {
        return false;
      }
      return str(ea.target) === path;
    });
    if (has_path_req) return "asked";
  }

  // Effect without ask = ANY examined receipt linked to this attempt (same attempt_seq)
  // whose classification is NOT asked (PR-11d: attempt may carry tool_call_id while
  // ACP disk-check receipt has only path).
  const linked = examined.some(
    (ex) => ex.attempt_seq === attempt.seq && ex.classification !== "asked",
  );
  if (linked) return "effect_without_ask";
  return "not_executed";
}

