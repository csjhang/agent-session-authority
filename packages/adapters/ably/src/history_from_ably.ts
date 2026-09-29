import {
  action_digest,
  format_unix_nano_decimal,
  serialize_history_jsonl,
  type HistoryEvent,
} from "@asa/core";
import type { AblyPeerEvent } from "./mock_peer.js";

export type HistoryEventLite = HistoryEvent;

export function ably_events_to_history(events: readonly AblyPeerEvent[]): HistoryEventLite[] {
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
      issuer_id: "ably_adapter_fixture",
      runtime_id: "ably-ai-transport",
      note: "Ably binds toolCallId / first-response-wins; no portable digest+generation enforcement",
    },
  });
  next({
    kind: "ok",
    op: "session.attach",
    session_id: sid,
    actor_id: "adapter",
    attrs: { mode: "fixture", fidelity: "reconstructed", transport: "ably-ai-transport", air_gap: false },
  });
  for (const e of events) {
    if (e.type === "session_open")
      next({ kind: "observe", op: "session.attach", session_id: e.sessionId, attrs: { channel: e.channel }, note: "ably session open" });
    else if (e.type === "run_start")
      next({
        kind: "observe",
        op: "session.attach",
        session_id: e.sessionId,
        attrs: { run_id: e.runId, invocation_id: e.invocationId },
        note: "ably run start",
      });
    else if (e.type === "tool_call_pending") {
      const action_type = `tool.${e.toolName}`;
      const target = e.toolName;
      const policy_version = "ably-hitl-tool-approval";
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
          tool_call_id: e.toolCallId,
          run_id: e.runId,
          runtime_generation: 1,
          policy_version,
          nonce: e.toolCallId,
          synthesized: true,
        },
      });
      next({
        kind: "invoke",
        op: "approval.request",
        session_id: e.sessionId,
        actor_id: "agent",
        attrs: { action_digest: digest, request_id: e.toolCallId, tool_name: e.toolName, run_id: e.runId },
      });
    } else if (e.type === "run_suspend")
      next({
        kind: "observe",
        op: "approval.request",
        session_id: e.sessionId,
        attrs: { run_id: e.runId, reason: e.reason },
        note: "run.suspend pending HITL",
      });
    else if (e.type === "client_reconnect")
      next({
        kind: "observe",
        op: "session.attach",
        session_id: e.sessionId,
        actor_id: e.clientId,
        attrs: { client_id: e.clientId },
        note: e.note,
      });
    else if (e.type === "tool_approval_response") {
      if (e.ignored)
        next({
          kind: "observe",
          op: "approval.deny",
          session_id: e.sessionId,
          actor_id: e.clientId,
          attrs: { request_id: e.toolCallId, ignored: true, reason: "first_response_wins" },
          note: "late approval ignored",
        });
      else
        next({
          kind: "ok",
          op: e.decision === "allow" ? "approval.grant" : "approval.deny",
          session_id: e.sessionId,
          actor_id: e.clientId,
          attrs: {
            approver: e.clientId,
            decision: e.decision === "allow" ? "grant" : "deny",
            request_id: e.toolCallId,
            run_id: e.runId,
            first_response_wins: e.firstResponseWins,
            fence_epoch: 1,
            note: "fence_epoch synthesized; Ably has no FenceToken",
          },
        });
    } else if (e.type === "run_resume")
      next({
        kind: "fault",
        fault: "runtime.restart",
        session_id: e.sessionId,
        attrs: { run_id: e.runId, new_invocation_id: e.newInvocationId, generation_bumped: false },
        note: e.note,
      });
    else if (e.type === "session_closed")
      next({ kind: "ok", op: "session.detach", session_id: e.sessionId, attrs: { reason: e.reason ?? "closed" } });
  }
  return out;
}
export const history_to_jsonl = (e: readonly HistoryEventLite[]): string =>
  serialize_history_jsonl(e as HistoryEvent[]);
