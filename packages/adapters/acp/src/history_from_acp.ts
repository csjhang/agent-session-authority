import type { AcpPeerEvent } from "./mock_peer.js";

/** Minimal history event shape (mirrors packages/core without importing it). */
export interface HistoryEventLite {
  seq: number;
  ts?: string;
  /** Unix nanoseconds as decimal string (not JSON number). */
  ts_unix_nano?: string;
  kind: "invoke" | "ok" | "fail" | "info" | "observe" | "fault";
  op?: string;
  fault?: string;
  session_id?: string;
  actor_id?: string;
  attrs?: Record<string, unknown>;
  note?: string;
}

/** Decimal-string unix nano from Date.now() ms (ms * 1e6; not true ns resolution). */
function format_unix_nano_decimal(epoch_ms: number = Date.now()): string {
  return String(BigInt(Math.trunc(epoch_ms)) * 1_000_000n);
}

function digest_of(toolName: string, input: Record<string, unknown>): string {
  const canonical = JSON.stringify({ toolName, input });
  let h = 0;
  for (let i = 0; i < canonical.length; i++) h = (h * 31 + canonical.charCodeAt(i)) >>> 0;
  return `acp_${toolName}_${h.toString(16)}`;
}

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

function effect_outcome_from_update(update: Record<string, unknown>): {
  outcome: "committed" | "unknown";
  reason?: string;
} {
  // Prefer content_mismatch over present-alone (matched===false wins first).
  if (update.matched === false) {
    return { outcome: "unknown", reason: "content_mismatch" };
  }
  if (update.absent === true || update.present === false) {
    return { outcome: "unknown", reason: "file_absent" };
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

/**
 * Convert observable ACP session/permission events into probe history JSONL objects.
 *
 * Multi-generation: each `runtime_restart` / process spawn after the initial attach
 * emits `fault=runtime.restart` and a new `generation.observe` with gen+1. Subsequent
 * action.bind / approval events carry the current `runtime_generation`.
 * approval.grant/deny are linked via request_id to the matching approval.request's
 * action_digest. effect_receipt session updates become effect.receipt with derived
 * field_provenance.
 */
export function acp_events_to_history(
  events: readonly AcpPeerEvent[],
  opts: { runtime_generation?: number; fence_epoch?: number; issuer_id?: string } = {},
): HistoryEventLite[] {
  let runtime_generation = opts.runtime_generation ?? 1;
  const fence_epoch = opts.fence_epoch ?? 1;
  const issuer_id = opts.issuer_id ?? "acp_adapter_fixture";
  const out: HistoryEventLite[] = [];
  let seq = 0;
  const next = (partial: Omit<HistoryEventLite, "seq">): void => {
    seq += 1;
    out.push({ seq, ts: new Date().toISOString(), ts_unix_nano: format_unix_nano_decimal(), ...partial });
  };

  const sid0 = session_id_of(events);
  next({
    kind: "observe",
    op: "generation.observe",
    session_id: sid0,
    attrs: { runtime_generation, issuer_id, runtime_id: "claude-agent-acp" },
  });
  next({
    kind: "ok",
    op: "session.attach",
    session_id: sid0,
    actor_id: "adapter",
    attrs: { mode: "fixture_or_live", fidelity: "reconstructed" },
  });

  /** request_id → action_digest + binding fields from the matching approval.request */
  const pending_by_request = new Map<
    string,
    { action_digest: string; tool_call_id?: string; tool_name?: string; runtime_generation: number }
  >();

  for (const ev of events) {
    if (ev.type === "runtime_restart") {
      next({
        kind: "fault",
        fault: "runtime.restart",
        session_id: ev.sessionId,
        note: ev.reason ?? "process_spawn",
        attrs: {
          previous_runtime_generation: runtime_generation,
          field_provenance: derived_provenance(["previous_runtime_generation"]),
        },
      });
      runtime_generation += 1;
      next({
        kind: "observe",
        op: "generation.observe",
        session_id: ev.sessionId,
        attrs: {
          runtime_generation,
          issuer_id,
          runtime_id: "claude-agent-acp",
          field_provenance: derived_provenance(["runtime_generation"]),
        },
      });
      continue;
    }

    if (ev.type === "session_update") {
      const kind = String(ev.update.kind ?? "update");
      if (kind === "effect_receipt") {
        const path = ev.update.path !== undefined ? String(ev.update.path) : undefined;
        const sink = String(ev.update.sink ?? "wait_for_write_effect");
        // Bind to nearest prior action.bind whose target equals the path.
        let bind_digest = "";
        let bind_tool_call_id: string | undefined;
        let binding: "linked" | "unlinked" = "unlinked";
        if (path) {
          for (let i = out.length - 1; i >= 0; i--) {
            const prev = out[i]!;
            if (prev.op === "action.bind" && String(prev.attrs?.target ?? "") === path) {
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
              : path
                ? `fs:${path}`
                : `effect-${seq + 1}`;
        const { outcome, reason } = effect_outcome_from_update(ev.update);
        // One receipt per path: merge later observations into the existing event.
        const existing =
          path !== undefined
            ? [...out].reverse().find((e) => e.op === "effect.receipt" && e.attrs?.path === path)
            : undefined;
        if (existing && existing.attrs) {
          const prev_sources = Array.isArray(existing.attrs.sources)
            ? (existing.attrs.sources as string[])
            : existing.attrs.sink
              ? [String(existing.attrs.sink)]
              : [];
          const sources = prev_sources.includes(sink) ? prev_sources : [...prev_sources, sink];
          // Recompute outcome from merged observation fields (later matched/present win when set).
          const merged_update: Record<string, unknown> = {
            ...Object.fromEntries(
              Object.entries(existing.attrs).filter(([k]) =>
                ["present", "absent", "matched", "expected", "content", "withhold"].includes(k),
              ),
            ),
            ...ev.update,
          };
          const merged = effect_outcome_from_update(merged_update);
          const next_attrs: Record<string, unknown> = {
            ...existing.attrs,
            outcome: merged.outcome,
            sink: sources[sources.length - 1],
            sources,
            observed_at: new Date().toISOString(),
            ...(ev.update.matched !== undefined ? { matched: ev.update.matched } : {}),
            ...(ev.update.present !== undefined ? { present: ev.update.present } : {}),
            ...(ev.update.absent !== undefined ? { absent: ev.update.absent } : {}),
            ...(ev.update.expected !== undefined ? { expected: ev.update.expected } : {}),
          };
          if (merged.reason) next_attrs.reason = merged.reason;
          else delete next_attrs.reason;
          existing.attrs = next_attrs;
        } else {
          next({
            kind: "ok",
            op: "effect.receipt",
            session_id: ev.sessionId,
            attrs: {
              effect_id,
              outcome,
              ...(reason ? { reason } : {}),
              ...(path ? { path } : {}),
              action_digest: binding === "linked" ? bind_digest : "",
              ...(bind_tool_call_id ? { tool_call_id: bind_tool_call_id } : {}),
              ...(binding === "unlinked" ? { binding: "unlinked" } : {}),
              runtime_generation,
              fence_epoch,
              sink,
              sources: [sink],
              observed_at: new Date().toISOString(),
              ...(ev.update.matched !== undefined ? { matched: ev.update.matched } : {}),
              ...(ev.update.present !== undefined ? { present: ev.update.present } : {}),
              ...(ev.update.absent !== undefined ? { absent: ev.update.absent } : {}),
              ...(ev.update.expected !== undefined ? { expected: ev.update.expected } : {}),
              field_provenance: derived_provenance([
                "outcome",
                "effect_id",
                "runtime_generation",
                "path",
                "observed_at",
                "action_digest",
              ]),
            },
            note: "derived from wait_for_write_effect / fs observation",
          });
        }
      } else {
        next({
          kind: "observe",
          op: "session.attach",
          session_id: ev.sessionId,
          attrs: { update_kind: kind, raw_update: ev.update },
          note: "acp session_update",
        });
      }
      continue;
    }

    if (ev.type === "permission_request") {
      const action_digest = digest_of(ev.toolName, ev.input);
      pending_by_request.set(ev.requestId, {
        action_digest,
        tool_call_id: ev.toolCallId,
        tool_name: ev.toolName,
        runtime_generation,
      });
      next({
        kind: "ok",
        op: "action.bind",
        session_id: ev.sessionId,
        actor_id: "agent",
        attrs: {
          action_type: `tool.${ev.toolName}`,
          target: String(ev.input.path ?? ev.toolName),
          args: ev.input,
          tool_call_id: ev.toolCallId,
          action_digest,
          runtime_generation,
          policy_version: "acp-permission-ext",
          nonce: ev.requestId,
          ...(ev.options !== undefined ? { offered_options: ev.options } : {}),
        },
      });
      next({
        kind: "invoke",
        op: "approval.request",
        session_id: ev.sessionId,
        actor_id: "agent",
        attrs: {
          tool_call_id: ev.toolCallId,
          action_digest,
          request_id: ev.requestId,
          tool_name: ev.toolName,
          runtime_generation,
          ...(ev.options !== undefined ? { offered_options: ev.options } : {}),
        },
      });
      continue;
    }

    if (ev.type === "permission_response") {
      const linked = pending_by_request.get(ev.requestId);
      const action_digest = linked?.action_digest;
      // request_runtime_generation = when request was issued; runtime_generation = when decision made
      const request_runtime_generation = linked?.runtime_generation ?? runtime_generation;
      next({
        kind: "ok",
        op: ev.decision === "allow" ? "approval.grant" : "approval.deny",
        session_id: ev.sessionId,
        actor_id: "approver_client",
        attrs: {
          approver: "approver_client",
          decision: ev.decision === "allow" ? "grant" : "deny",
          request_id: ev.requestId,
          ...(action_digest !== undefined ? { action_digest } : {}),
          runtime_generation,
          request_runtime_generation,
          fence_epoch,
          ...(ev.optionId !== undefined ? { option_id: ev.optionId } : {}),
          ...(ev.optionKind !== undefined ? { option_kind: ev.optionKind } : {}),
          ...(linked?.tool_call_id !== undefined ? { tool_call_id: linked.tool_call_id } : {}),
        },
      });
      continue;
    }

    if (ev.type === "session_closed") {
      next({
        kind: "ok",
        op: "session.detach",
        session_id: ev.sessionId,
        attrs: { reason: ev.reason ?? "closed" },
      });
    }
  }
  return out;
}

export function history_to_jsonl(events: readonly HistoryEventLite[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}
