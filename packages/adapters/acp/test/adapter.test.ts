import { describe, expect, it } from "vitest";
import { collect_history, MockAcpPeer, acp_events_to_history } from "../src/index.js";

describe("@asa/adapter-acp fixture", () => {
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
});
