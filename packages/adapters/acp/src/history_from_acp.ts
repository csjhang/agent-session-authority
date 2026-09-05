import type { AcpPeerEvent } from "./mock_peer.js";

/** Minimal history event shape (mirrors packages/core without importing it). */
export interface HistoryEventLite {
  seq: number;
  ts?: string;
  kind: "invoke" | "ok" | "fail" | "info" | "observe" | "fault";
  op?: string;
  session_id?: string;
  actor_id?: string;
  attrs?: Record<string, unknown>;
  note?: string;
}

function digest_of(toolName: string, input: Record<string, unknown>): string {
  const canonical = JSON.stringify({ toolName, input });
  let h = 0;
  for (let i = 0; i < canonical.length; i++) h = (h * 31 + canonical.charCodeAt(i)) >>> 0;
  return `acp_${toolName}_${h.toString(16)}`;
}

/**
 * Convert observable ACP session/permission events into probe history JSONL objects.
 */
export function acp_events_to_history(
  events: readonly AcpPeerEvent[],
  opts: { runtime_generation?: number; fence_epoch?: number } = {},
): HistoryEventLite[] {
  const runtime_generation = opts.runtime_generation ?? 1;
  const fence_epoch = opts.fence_epoch ?? 1;
  const out: HistoryEventLite[] = [];
  let seq = 0;
  const next = (partial: Omit<HistoryEventLite, "seq">): void => {
    seq += 1;
    out.push({ seq, ts: new Date().toISOString(), ...partial });
  };

  next({
    kind: "observe",
    op: "generation.observe",
    session_id: events[0] && "sessionId" in events[0] ? events[0].sessionId : undefined,
    attrs: { runtime_generation, issuer_id: "acp_adapter_fixture", runtime_id: "claude-agent-acp" },
  });

  next({
    kind: "ok",
    op: "session.attach",
    session_id: events[0] && "sessionId" in events[0] ? events[0].sessionId : undefined,
    actor_id: "adapter",
    attrs: { mode: "fixture_or_live", fidelity: "reconstructed" },
  });

  for (const ev of events) {
    if (ev.type === "session_update") {
      next({
        kind: "observe",
        op: "session.attach",
        session_id: ev.sessionId,
        attrs: { update_kind: String(ev.update.kind ?? "update"), raw_update: ev.update },
        note: "acp session_update",
      });
    } else if (ev.type === "permission_request") {
      const action_digest = digest_of(ev.toolName, ev.input);
      next({
        kind: "ok",
        op: "action.bind",
        session_id: ev.sessionId,
        actor_id: "agent",
        attrs: {
          action_type: `tool.${ev.toolName}`,
          target: String(ev.input.path ?? ev.toolName),
          args: ev.input,
          action_digest,
          runtime_generation,
          policy_version: "acp-permission-ext",
          nonce: ev.requestId,
        },
      });
      next({
        kind: "invoke",
        op: "approval.request",
        session_id: ev.sessionId,
        actor_id: "agent",
        attrs: {
          action_digest,
          request_id: ev.requestId,
          tool_name: ev.toolName,
        },
      });
    } else if (ev.type === "permission_response") {
      next({
        kind: "ok",
        op: ev.decision === "allow" ? "approval.grant" : "approval.deny",
        session_id: ev.sessionId,
        actor_id: "approver_client",
        attrs: {
          approver: "approver_client",
          decision: ev.decision === "allow" ? "grant" : "deny",
          request_id: ev.requestId,
          fence_epoch,
        },
      });
    } else if (ev.type === "session_closed") {
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
