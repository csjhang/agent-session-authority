import path from "node:path";
import {
  action_digest,
  format_unix_nano_decimal,
  serialize_history_jsonl,
  type HistoryEvent,
} from "@asa/core";
import type { AcpPeerEvent } from "./mock_peer.js";

export type HistoryEventLite = HistoryEvent;

function session_id_of(events: readonly AcpPeerEvent[]): string | undefined {
  for (const ev of events) {
    if ("sessionId" in ev && typeof ev.sessionId === "string") return ev.sessionId;
  }
  return undefined;
}

function derived_provenance(fields: string[]): Record<string, "derived"> {
  const out: Record<string, "derived"> = {};
  for (const f of fields) out[f] = "derived";
  return out;
}

/**
 * Prefer input.file_path, then input.path, else toolName (live titles like
 * "Write asa-x.txt" are not paths — callers with file_path win).
 * Path-normalize ONLY when the value came from file_path/path; toolName stays raw.
 */
function bind_target(
  toolName: string,
  input: Record<string, unknown>,
  session_cwd: string | undefined,
): { target: string; target_kind: "path" | "tool_name" } {
  if (typeof input.file_path === "string" && input.file_path.length > 0) {
    return { target: normalize_path(input.file_path, session_cwd), target_kind: "path" };
  }
  if (typeof input.path === "string" && input.path.length > 0) {
    return { target: normalize_path(input.path, session_cwd), target_kind: "path" };
  }
  return { target: toolName, target_kind: "tool_name" };
}

/**
 * Resolve relative paths against session cwd; leave absolute as normalized.
 * Always emit "/" separators so `fs:` effect_id path parts are platform-stable
 * (win32-style inputs like `C:\\ws\\a.txt` never introduce backslashes).
 */
function normalize_path(p: string, session_cwd: string | undefined): string {
  if (!p) return p;
  const s = p.replace(/\\/g, "/");
  const cwd = session_cwd ? session_cwd.replace(/\\/g, "/") : undefined;
  const is_abs = s.startsWith("/") || /^[A-Za-z]:\//.test(s);
  if (is_abs) return path.posix.normalize(s);
  if (cwd) return path.posix.normalize(path.posix.join(cwd, s));
  return path.posix.normalize(s);
}

/**
 * Match action.bind target to receipt path.
 * Case-fold only when BOTH paths are Windows drive paths (/^[A-Za-z]:\//);
 * otherwise compare exactly (host-independent).
 */
function paths_equal(a: string, b: string): boolean {
  const win_drive = /^[A-Za-z]:\//;
  if (win_drive.test(a) && win_drive.test(b)) {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

function discover_session_cwd(
  events: readonly AcpPeerEvent[],
  opts_cwd: string | undefined,
): string | undefined {
  if (opts_cwd) return opts_cwd;
  for (const ev of events) {
    if (ev.type !== "session_update") continue;
    const kind = String(ev.update.kind ?? "");
    if (kind === "session_new" || kind === "session_load" || kind === "session_resume") {
      if (typeof ev.update.cwd === "string" && ev.update.cwd.length > 0) return ev.update.cwd;
      const params = ev.update.params as Record<string, unknown> | undefined;
      if (params && typeof params.cwd === "string" && params.cwd.length > 0) return params.cwd;
    }
  }
  return undefined;
}

/** Derive absent ↔ present so flags stay consistent for a single observation. */
function normalize_observation_flags(update: Record<string, unknown>): Record<string, unknown> {
  const u = { ...update };
  if (u.present === true) {
    u.absent = false;
  } else if (u.present === false) {
    u.absent = true;
  } else if (u.absent === true) {
    u.present = false;
  } else if (u.absent === false) {
    u.present = true;
  }
  return u;
}

function effect_outcome_from_update(update: Record<string, unknown>): {
  outcome: "committed" | "unknown";
  reason?: string;
} {
  // Absent file is always file_absent, even when the reader also set matched=false.
  // content_mismatch only applies when the file exists but contents differ.
  if (update.absent === true || update.present === false) {
    return { outcome: "unknown", reason: "file_absent" };
  }
  if (update.matched === false) {
    return { outcome: "unknown", reason: "content_mismatch" };
  }
  if (update.matched === true) {
    return { outcome: "committed" };
  }
  // Present (or content observed) but no content compare → not committed.
  if (update.present === true || (update.content !== undefined && update.content !== null)) {
    return { outcome: "unknown", reason: "content_not_verified" };
  }
  return { outcome: "unknown", reason: "effect_not_observed" };
}

/** Events that break adjacency for same-path receipt merge. */
function is_receipt_merge_blocker(ev: HistoryEventLite): boolean {
  if (ev.fault === "runtime.restart") return true;
  if (ev.op === "action.bind") return true;
  if (typeof ev.op === "string" && ev.op.startsWith("approval.")) return true;
  // permission_* peer events become action.bind / approval.*; no separate op.
  return false;
}

/**
 * Index of the latest effect.receipt for `path` if no blockers follow it.
 * Otherwise undefined → emit a fresh receipt.
 */
function find_adjacent_receipt_index(out: readonly HistoryEventLite[], path_norm: string): number | undefined {
  let last_idx: number | undefined;
  for (let i = 0; i < out.length; i++) {
    const e = out[i]!;
    if (e.op === "effect.receipt" && paths_equal(String(e.attrs?.path ?? ""), path_norm)) {
      last_idx = i;
    }
  }
  if (last_idx === undefined) return undefined;
  for (let i = last_idx + 1; i < out.length; i++) {
    if (is_receipt_merge_blocker(out[i]!)) return undefined;
  }
  return last_idx;
}

type PendingApproval = {
  action_digest: string;
  tool_call_id?: string;
  tool_name?: string;
  runtime_generation: number;
};

/** Earliest finite observed_at_ms among peer events, if any. */
function earliest_observed_at_ms(events: readonly AcpPeerEvent[]): number | undefined {
  let min: number | undefined;
  for (const ev of events) {
    if (typeof ev.observed_at_ms === "number" && Number.isFinite(ev.observed_at_ms)) {
      if (min === undefined || ev.observed_at_ms < min) min = ev.observed_at_ms;
    }
  }
  return min;
}

/**
 * Convert observable ACP session/permission events into probe history JSONL objects.
 *
 * Multi-generation: each `runtime_restart` / process spawn after the initial attach
 * emits `fault=runtime.restart` and a new `generation.observe` with gen+1. Subsequent
 * action.bind / approval events carry the current `runtime_generation`.
 * approval.grant/deny are linked via request_id to the matching approval.request's
 * action_digest. Stale/orphan replies (no pending request) become approval.record.
 * effect_receipt session updates become effect.receipt with derived field_provenance.
 * Same-path receipts merge only when adjacent (no bind/approval/restart between).
 */
export function acp_events_to_history(
  events: readonly AcpPeerEvent[],
  opts: {
    runtime_generation?: number;
    fence_epoch?: number;
    issuer_id?: string;
    /** Session cwd from session/new (or run opts); used to absolutize relative paths. */
    session_cwd?: string;
  } = {},
): HistoryEventLite[] {
  let runtime_generation = opts.runtime_generation ?? 1;
  const fence_epoch = opts.fence_epoch ?? 1;
  const issuer_id = opts.issuer_id ?? "acp_adapter_fixture";
  const session_cwd = discover_session_cwd(events, opts.session_cwd);
  const out: HistoryEventLite[] = [];
  let seq = 0;
  const next = (
    partial: Omit<HistoryEventLite, "seq">,
    source_observed_at_ms?: number,
  ): void => {
    seq += 1;
    const has_obs = typeof source_observed_at_ms === "number" && Number.isFinite(source_observed_at_ms);
    const epoch_ms = has_obs ? source_observed_at_ms! : Date.now();
    let attrs = partial.attrs;
    if (!has_obs) {
      const prev_fp =
        attrs && typeof attrs.field_provenance === "object" && attrs.field_provenance !== null
          ? (attrs.field_provenance as Record<string, unknown>)
          : {};
      attrs = {
        ...attrs,
        field_provenance: { ...prev_fp, ts: "derived" },
      };
    }
    out.push({
      ...partial,
      seq,
      ts: new Date(epoch_ms).toISOString(),
      ts_unix_nano: format_unix_nano_decimal(epoch_ms),
      ...(attrs !== undefined ? { attrs } : {}),
    });
  };
  const renumber = (): void => {
    for (let i = 0; i < out.length; i++) out[i]!.seq = i + 1;
    seq = out.length;
  };

  const sid0 = session_id_of(events);
  // Header observe/attach: use earliest peer observed_at_ms so they do not sit
  // after later events that carry older observed times. Fall back to conversion
  // time when no observed_at_ms is present. Always mark ts as derived.
  const header_obs_ms = earliest_observed_at_ms(events);
  next(
    {
      kind: "observe",
      op: "generation.observe",
      session_id: sid0,
      attrs: {
        runtime_generation,
        issuer_id,
        runtime_id: "claude-agent-acp",
        // The starting generation is assigned by the adapter, not reported by the target.
        field_provenance: { ts: "derived", runtime_generation: "derived" },
      },
    },
    header_obs_ms,
  );
  next(
    {
      kind: "ok",
      op: "session.attach",
      session_id: sid0,
      actor_id: "adapter",
      attrs: {
        mode: "fixture_or_live",
        fidelity: "reconstructed",
        field_provenance: { ts: "derived" },
      },
    },
    header_obs_ms,
  );

  /** request_id → action_digest + binding fields from the matching approval.request */
  const pending_by_request = new Map<string, PendingApproval>();
  /** Survives after grant/deny so orphan replies can recover request_runtime_generation. */
  const answered_by_request = new Map<string, PendingApproval>();

  for (const ev of events) {
    if (ev.type === "runtime_restart") {
      next(
        {
          kind: "fault",
          fault: "runtime.restart",
          session_id: ev.sessionId,
          note: ev.reason ?? "process_spawn",
          attrs: {
            previous_runtime_generation: runtime_generation,
            field_provenance: derived_provenance(["previous_runtime_generation"]),
          },
        },
        ev.observed_at_ms,
      );
      runtime_generation += 1;
      next(
        {
          kind: "observe",
          op: "generation.observe",
          session_id: ev.sessionId,
          attrs: {
            runtime_generation,
            issuer_id,
            runtime_id: "claude-agent-acp",
            field_provenance: derived_provenance(["runtime_generation"]),
          },
        },
        ev.observed_at_ms,
      );
      continue;
    }

    if (ev.type === "session_update") {
      const kind = String(ev.update.kind ?? "update");
      if (kind === "effect_receipt") {
        const path_raw = ev.update.path !== undefined ? String(ev.update.path) : undefined;
        const path_norm = path_raw !== undefined ? normalize_path(path_raw, session_cwd) : undefined;
        const sink = String(ev.update.sink ?? "wait_for_write_effect");
        // Bind to nearest prior action.bind whose target equals the normalized path.
        let bind_digest = "";
        let bind_tool_call_id: string | undefined;
        let binding: "linked" | "unlinked" = "unlinked";
        if (path_norm) {
          for (let i = out.length - 1; i >= 0; i--) {
            const prev = out[i]!;
            if (prev.op === "action.bind" && paths_equal(String(prev.attrs?.target ?? ""), path_norm)) {
              bind_digest = typeof prev.attrs?.action_digest === "string" ? prev.attrs.action_digest : "";
              bind_tool_call_id =
                typeof prev.attrs?.tool_call_id === "string" ? prev.attrs.tool_call_id : undefined;
              binding = "linked";
              break;
            }
          }
        }
        const effect_id =
          typeof ev.update.effect_id === "string"
            ? ev.update.effect_id
            : bind_tool_call_id
              ? bind_tool_call_id
              : path_norm
                ? `fs:${path_norm}`
                : `effect-${seq + 1}`;

        const latest = normalize_observation_flags(ev.update);
        const { outcome, reason } = effect_outcome_from_update(latest);
        const obs_ms =
          typeof ev.observed_at_ms === "number" && Number.isFinite(ev.observed_at_ms)
            ? ev.observed_at_ms
            : Date.now();
        const obs_iso = new Date(obs_ms).toISOString();

        const adj_idx = path_norm !== undefined ? find_adjacent_receipt_index(out, path_norm) : undefined;
        if (adj_idx !== undefined) {
          // Adjacent merge: remove prior receipt (do not mutate in place), re-emit from latest.
          const prior = out[adj_idx]!;
          const prev_sources = Array.isArray(prior.attrs?.sources)
            ? (prior.attrs!.sources as string[])
            : prior.attrs?.sink
              ? [String(prior.attrs.sink)]
              : [];
          const sources = prev_sources.includes(sink) ? prev_sources : [...prev_sources, sink];
          out.splice(adj_idx, 1);
          renumber();
          // Re-bind after splice (nearest matching action.bind still in out).
          let merge_digest = bind_digest;
          let merge_tool_call_id = bind_tool_call_id;
          let merge_binding = binding;
          let merge_effect_id = effect_id;
          if (path_norm) {
            for (let i = out.length - 1; i >= 0; i--) {
              const prev = out[i]!;
              if (prev.op === "action.bind" && paths_equal(String(prev.attrs?.target ?? ""), path_norm)) {
                merge_digest = typeof prev.attrs?.action_digest === "string" ? prev.attrs.action_digest : "";
                merge_tool_call_id =
                  typeof prev.attrs?.tool_call_id === "string" ? prev.attrs.tool_call_id : undefined;
                merge_binding = "linked";
                merge_effect_id =
                  typeof ev.update.effect_id === "string"
                    ? ev.update.effect_id
                    : merge_tool_call_id
                      ? merge_tool_call_id
                      : `fs:${path_norm}`;
                break;
              }
            }
          }
          const provenance_fields = [
            "outcome",
            "effect_id",
            "runtime_generation",
            "path",
            "observed_at",
            ...(merge_binding === "linked" ? ["action_digest"] : []),
          ];
          next({
            kind: "ok",
            op: "effect.receipt",
            session_id: ev.sessionId,
            attrs: {
              effect_id: merge_effect_id,
              outcome,
              ...(reason ? { reason } : {}),
              ...(path_norm ? { path: path_norm } : {}),
              ...(merge_binding === "linked"
                ? { action_digest: merge_digest }
                : { binding: "unlinked" }),
              ...(merge_tool_call_id ? { tool_call_id: merge_tool_call_id } : {}),
              runtime_generation,
              fence_epoch,
              sink: sources[sources.length - 1],
              sources,
              observed_at: obs_iso,
              ...(latest.matched !== undefined ? { matched: latest.matched } : {}),
              ...(latest.present !== undefined ? { present: latest.present } : {}),
              ...(latest.absent !== undefined ? { absent: latest.absent } : {}),
              ...(latest.expected !== undefined ? { expected: latest.expected } : {}),
              ...(latest.content !== undefined ? { content: latest.content } : {}),
              field_provenance: derived_provenance(provenance_fields),
            },
            note: "derived from wait_for_write_effect / fs observation",
          },
          ev.observed_at_ms,
          );
        } else {
          const provenance_fields = [
            "outcome",
            "effect_id",
            "runtime_generation",
            "path",
            "observed_at",
            ...(binding === "linked" ? ["action_digest"] : []),
          ];
          next({
            kind: "ok",
            op: "effect.receipt",
            session_id: ev.sessionId,
            attrs: {
              effect_id,
              outcome,
              ...(reason ? { reason } : {}),
              ...(path_norm ? { path: path_norm } : {}),
              ...(binding === "linked" ? { action_digest: bind_digest } : { binding: "unlinked" }),
              ...(bind_tool_call_id ? { tool_call_id: bind_tool_call_id } : {}),
              runtime_generation,
              fence_epoch,
              sink,
              sources: [sink],
              observed_at: obs_iso,
              ...(latest.matched !== undefined ? { matched: latest.matched } : {}),
              ...(latest.present !== undefined ? { present: latest.present } : {}),
              ...(latest.absent !== undefined ? { absent: latest.absent } : {}),
              ...(latest.expected !== undefined ? { expected: latest.expected } : {}),
              ...(latest.content !== undefined ? { content: latest.content } : {}),
              field_provenance: derived_provenance(provenance_fields),
            },
            note: "derived from wait_for_write_effect / fs observation",
          },
          ev.observed_at_ms,
          );
        }
      } else {
        next(
          {
            kind: "observe",
            op: "session.attach",
            session_id: ev.sessionId,
            attrs: { update_kind: kind, raw_update: ev.update },
            note: "acp session_update",
          },
          ev.observed_at_ms,
        );
      }
      continue;
    }

    if (ev.type === "permission_request") {
      const { target, target_kind } = bind_target(ev.toolName, ev.input, session_cwd);
      const action_type = `tool.${ev.toolName}`;
      const policy_version = "acp-permission-ext";
      const digest = action_digest({
        action_type,
        target,
        args: ev.input,
        policy_version,
      });
      pending_by_request.set(ev.requestId, {
        action_digest: digest,
        tool_call_id: ev.toolCallId,
        tool_name: ev.toolName,
        runtime_generation,
      });
      next(
        {
          kind: "ok",
          op: "action.bind",
          session_id: ev.sessionId,
          actor_id: "agent",
          attrs: {
            action_type,
            target,
            target_kind,
            args: ev.input,
            tool_call_id: ev.toolCallId,
            action_digest: digest,
            runtime_generation,
            policy_version,
            nonce: ev.requestId,
            ...(ev.options !== undefined ? { offered_options: ev.options } : {}),
          },
        },
        ev.observed_at_ms,
      );
      next(
        {
          kind: "invoke",
          op: "approval.request",
          session_id: ev.sessionId,
          actor_id: "agent",
          attrs: {
            tool_call_id: ev.toolCallId,
            action_digest: digest,
            request_id: ev.requestId,
            tool_name: ev.toolName,
            runtime_generation,
            ...(ev.options !== undefined ? { offered_options: ev.options } : {}),
          },
        },
        ev.observed_at_ms,
      );
      continue;
    }

    if (ev.type === "permission_response") {
      const linked = pending_by_request.get(ev.requestId);

      // Cancelled client outcome → always approval.record (never grant/deny).
      if (ev.decision === "cancelled") {
        let action_digest: string | undefined;
        let tool_call_id: string | undefined;
        let request_runtime_generation = runtime_generation;
        if (linked) {
          action_digest = linked.action_digest;
          tool_call_id = linked.tool_call_id;
          request_runtime_generation = linked.runtime_generation;
          pending_by_request.delete(ev.requestId);
          answered_by_request.set(ev.requestId, linked);
        } else {
          const prior = answered_by_request.get(ev.requestId);
          action_digest = prior?.action_digest;
          tool_call_id = prior?.tool_call_id;
          request_runtime_generation = prior?.runtime_generation ?? runtime_generation;
          if (action_digest === undefined) {
            for (let i = out.length - 1; i >= 0; i--) {
              const prev = out[i]!;
              if (prev.op === "approval.request" && prev.attrs?.request_id === ev.requestId) {
                if (typeof prev.attrs.runtime_generation === "number") {
                  request_runtime_generation = prev.attrs.runtime_generation;
                }
                if (typeof prev.attrs.action_digest === "string") action_digest = prev.attrs.action_digest;
                if (typeof prev.attrs.tool_call_id === "string") tool_call_id = prev.attrs.tool_call_id;
                break;
              }
            }
          }
        }
        next(
          {
            kind: "ok",
            op: "approval.record",
            session_id: ev.sessionId,
            actor_id: "approver_client",
            attrs: {
              approver: "approver_client",
              decision: "cancelled",
              client_outcome: "cancelled",
              ...(ev.reason !== undefined ? { reason: ev.reason } : {}),
              request_id: ev.requestId,
              ...(action_digest !== undefined ? { action_digest } : {}),
              runtime_generation,
              request_runtime_generation,
              fence_epoch,
              ...(tool_call_id !== undefined ? { tool_call_id } : {}),
            },
          },
          ev.observed_at_ms,
        );
        continue;
      }

      const decision = ev.decision === "allow" ? "grant" : "deny";
      if (!linked) {
        // Orphan / stale reply: no pending request for this requestId.
        const prior = answered_by_request.get(ev.requestId);
        // Fall back to scanning prior approval.request in history.
        let request_runtime_generation = prior?.runtime_generation;
        let action_digest = prior?.action_digest;
        let tool_call_id = prior?.tool_call_id;
        if (request_runtime_generation === undefined) {
          for (let i = out.length - 1; i >= 0; i--) {
            const prev = out[i]!;
            if (prev.op === "approval.request" && prev.attrs?.request_id === ev.requestId) {
              if (typeof prev.attrs.runtime_generation === "number") {
                request_runtime_generation = prev.attrs.runtime_generation;
              }
              if (typeof prev.attrs.action_digest === "string") action_digest = prev.attrs.action_digest;
              if (typeof prev.attrs.tool_call_id === "string") tool_call_id = prev.attrs.tool_call_id;
              break;
            }
          }
        }
        next(
          {
            kind: "ok",
            op: "approval.record",
            session_id: ev.sessionId,
            actor_id: "approver_client",
            attrs: {
              approver: "approver_client",
              decision,
              orphan: true,
              acknowledged: "unknown",
              request_id: ev.requestId,
              ...(action_digest !== undefined ? { action_digest } : {}),
              runtime_generation,
              request_runtime_generation: request_runtime_generation ?? runtime_generation,
              fence_epoch,
              ...(ev.optionId !== undefined ? { option_id: ev.optionId } : {}),
              ...(ev.optionKind !== undefined ? { option_kind: ev.optionKind } : {}),
              ...(tool_call_id !== undefined ? { tool_call_id } : {}),
            },
          },
          ev.observed_at_ms,
        );
        continue;
      }

      pending_by_request.delete(ev.requestId);
      answered_by_request.set(ev.requestId, linked);
      const action_digest = linked.action_digest;
      const request_runtime_generation = linked.runtime_generation;
      next(
        {
          kind: "ok",
          op: ev.decision === "allow" ? "approval.grant" : "approval.deny",
          session_id: ev.sessionId,
          actor_id: "approver_client",
          attrs: {
            approver: "approver_client",
            decision,
            request_id: ev.requestId,
            action_digest,
            runtime_generation,
            request_runtime_generation,
            fence_epoch,
            ...(ev.optionId !== undefined ? { option_id: ev.optionId } : {}),
            ...(ev.optionKind !== undefined ? { option_kind: ev.optionKind } : {}),
            ...(linked.tool_call_id !== undefined ? { tool_call_id: linked.tool_call_id } : {}),
          },
        },
        ev.observed_at_ms,
      );
      continue;
    }

    if (ev.type === "session_closed") {
      next(
        {
          kind: "ok",
          op: "session.detach",
          session_id: ev.sessionId,
          attrs: { reason: ev.reason ?? "closed" },
        },
        ev.observed_at_ms,
      );
    }
  }
  return out;
}

export const history_to_jsonl = (events: readonly HistoryEventLite[]): string =>
  serialize_history_jsonl(events as HistoryEvent[]);
