import { describe, expect, it } from "vitest";
import {
  collect_history,
  MockAcpPeer,
  acp_events_to_history,
  build_initialize_v1,
  build_session_new,
  build_session_prompt,
  build_session_cancel,
  build_session_close,
  build_session_load,
  build_session_resume,
  build_permission_selected,
  pick_allow_option_id,
  pick_deny_option_id,
} from "../src/index.js";

describe("@asa/adapter-acp fixture", () => {
  it("builds ACP v1 session and permission messages", () => {
    expect(build_initialize_v1(1).method).toBe("initialize");
    expect(build_session_new(2, "/tmp/asa")).toMatchObject({ id: 2, method: "session/new", params: { cwd: "/tmp/asa", mcpServers: [] } });
    expect(build_session_prompt(3, "s1", "OK")).toMatchObject({ id: 3, method: "session/prompt", params: { sessionId: "s1", prompt: [{ type: "text", text: "OK" }] } });
    expect(build_session_cancel(4, "s1").method).toBe("session/cancel");
    expect(build_session_close(5, "s1", "done").params).toMatchObject({ sessionId: "s1", reason: "done" });
    expect(build_session_load(6, "s1", "/tmp/asa").method).toBe("session/load");
    expect(build_session_resume(7, "s1").method).toBe("session/resume");
    expect(build_permission_selected(8, "allow_once")).toMatchObject({ id: 8, result: { outcome: { outcome: "selected", optionId: "allow_once" } } });
  });

  it("prefers allow_once and never selects deny", () => {
    expect(pick_allow_option_id([{ optionId: "allow_always" }, { optionId: "allow_once" }, { optionId: "deny" }])).toBe("allow_once");
    expect(pick_allow_option_id([{ optionId: "deny" }, { optionId: "cancel" }])).toBeUndefined();
  });

  it("prefers explicit reject option for withhold", () => {
    expect(pick_deny_option_id([
      { optionId: "allow-once", kind: "allow_once" },
      { optionId: "reject", kind: "reject_once" },
    ])).toBe("reject");
    expect(pick_deny_option_id([{ optionId: "allow-once", kind: "allow_once" }])).toBeUndefined();
  });

  it("mock peer emits permission + session events", () => {
    const peer = new MockAcpPeer({ sessionId: "s-test" });
    const events = peer.run_fixture_scenario();
    expect(events.some((e) => e.type === "permission_request")).toBe(true);
    expect(events.some((e) => e.type === "permission_response")).toBe(true);
    expect(events.at(-1)?.type).toBe("session_closed");
  });

  it("converts ACP events to history JSONL pipeline", async () => {
    const result = await collect_history({ mode: "fixture" });
    expect(result.mode).toBe("fixture");
    expect(result.package_version_pinned).toBe("0.75.1");
    expect(result.history.length).toBeGreaterThan(3);
    expect(result.history.some((e) => e.op === "approval.grant")).toBe(true);
    expect(result.history_jsonl.split("\n").filter(Boolean).length).toBe(result.history.length);
  });

  it("LIVE without key fails closed", async () => {
    await expect(collect_history({ mode: "live", env: {} })).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it("history_from_acp is deterministic on digests", () => {
    const peer = new MockAcpPeer();
    const a = acp_events_to_history(peer.run_fixture_scenario());
    const peer2 = new MockAcpPeer();
    const b = acp_events_to_history(peer2.run_fixture_scenario());
    const dig_a = a.find((e) => e.op === "action.bind")?.attrs?.action_digest;
    const dig_b = b.find((e) => e.op === "action.bind")?.attrs?.action_digest;
    expect(dig_a).toBe(dig_b);
  });

  it("accepts stale-grant scenario in fixture mode without live peer", async () => {
    const result = await collect_history({ mode: "fixture", scenario: "stale-grant" });
    expect(result.mode).toBe("fixture");
    expect(result.history.some((e) => e.op === "approval.grant")).toBe(true);
  });

  it("accepts stale-effect scenario in fixture mode without live peer", async () => {
    const result = await collect_history({ mode: "fixture", scenario: "stale-effect" });
    expect(result.mode).toBe("fixture");
    expect(result.package_version_pinned).toBe("0.75.1");
    expect(result.history.length).toBeGreaterThan(3);
  });
});
