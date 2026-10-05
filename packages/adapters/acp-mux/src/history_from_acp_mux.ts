import {
  action_digest,
  format_unix_nano_decimal,
  serialize_history_jsonl,
  type HistoryEvent,
} from "@asa/core";
import type { AcpMuxPeerEvent } from "./mock_peer.js";

export type HistoryEventLite = HistoryEvent;

export function acp_mux_events_to_history(events: readonly AcpMuxPeerEvent[]): HistoryEventLite[] {
  const out: HistoryEventLite[] = [];
  let seq = 0;
  const next = (x: Omit<HistoryEventLite, "seq">) =>
    out.push({ seq: ++seq, ts: new Date().toISOString(), ts_unix_nano: format_unix_nano_decimal(), ...x });
  const sid = events[0] && "sessionId" in events[0] ? events[0].sessionId : undefined;
  next({
    kind: "observe",
    op: "generation.observe",
    session_id: sid,
    attrs: {
      runtime_generation: 1,
      issuer_id: "acp_mux_adapter_fixture",
      runtime_id: "acp-mux",
      note: "acp-mux observation attach only — no fencing/lease/digest/generation/revocation",
      // Same per-field provenance as the ACP adapter header: adapter clock + adapter-stamped generation.
      // (acp-mux has no adapter session.attach header; its first attach comes from the peer.)
      field_provenance: { ts: "derived", runtime_generation: "derived" },
    },
  });
  for (const e of events) {
    if (e.type === "session_new")
      next({ kind: "ok", op: "session.attach", session_id: e.sessionId, actor_id: e.primaryClientId, attrs: { role: "primary" } });
    else if (e.type === "permission_request") {
      const action_type = `tool.${e.toolName}`;
      const target = String(e.input.path ?? e.toolName);
      const policy_version = "acp-mux-pending-reissue";
      const digest = action_digest({ action_type, target, args: e.input, policy_version });
      next({
        kind: "ok",
        op: "action.bind",
        session_id: e.sessionId,
        actor_id: "agent",
        attrs: {
          action_type,
          target,
          args: e.input,
          action_digest: digest,
          runtime_generation: 1,
          policy_version,
          nonce: e.requestId,
          synthesized: true,
          pending: true,
        },
      });
      next({
        kind: "invoke",
        op: "approval.request",
        session_id: e.sessionId,
        actor_id: "agent",
        attrs: { action_digest: digest, request_id: e.requestId, tool_name: e.toolName, pending: true },
      });
    } else if (e.type === "observer_attach")
      next({
        kind: "ok",
        op: "session.attach",
        session_id: e.sessionId,
        actor_id: e.observerClientId,
        attrs: { role: "observer", history_policy: e.historyPolicy, rfd: 533 },
        note: "observation attach",
      });
    else if (e.type === "pending_permission_reissue")
      next({
        kind: "observe",
        op: "approval.request",
        session_id: e.sessionId,
        actor_id: e.observerClientId,
        attrs: {
          request_id: e.requestId,
          reissued: true,
          fencing: false,
          lease: false,
          digest_native: false,
          generation_native: false,
        },
        note: e.note,
      });
    else if (e.type === "permission_response")
      next({
        kind: "ok",
        op: e.decision === "allow" ? "approval.grant" : "approval.deny",
        session_id: e.sessionId,
        actor_id: e.responderClientId,
        attrs: {
          approver: e.responderClientId,
          decision: e.decision === "allow" ? "grant" : "deny",
          request_id: e.requestId,
          first_wins: e.firstWins,
          fence_epoch: 1,
          note: "fence_epoch synthesized; acp-mux has no FenceToken",
        },
      });
    else if (e.type === "permission_resolved")
      next({
        kind: "observe",
        op: "approval.grant",
        session_id: e.sessionId,
        actor_id: e.toClientId,
        attrs: { request_id: e.requestId, update: "permission_resolved" },
        note: "broadcast resolved to other clients",
      });
    else if (e.type === "session_detach")
      next({
        kind: "ok",
        op: "session.detach",
        session_id: e.sessionId,
        actor_id: e.clientId,
        attrs: { client_id: e.clientId },
      });
    else if (e.type === "session_closed")
      next({ kind: "ok", op: "session.detach", session_id: e.sessionId, attrs: { reason: e.reason ?? "closed" } });
  }
  return out;
}
export const history_to_jsonl = (e: readonly HistoryEventLite[]): string =>
  serialize_history_jsonl(e as HistoryEvent[]);
