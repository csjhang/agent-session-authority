import { describe, expect, it } from "vitest";
import { collect_history, MockAhpPeer, ahp_events_to_history } from "../src/index.js";
describe("@asa/adapter-ahp fixture", () => {
  it("mock peer emits multi-client + first-wins confirmation + host death", () => { const events = new MockAhpPeer({ sessionId: "s-test" }).run_fixture_scenario(); expect(events.filter((e) => e.type === "client_subscribe").length).toBe(2); expect(events.some((e) => e.type === "tool_confirmation_request")).toBe(true); expect(events.some((e) => e.type === "tool_confirmation_response" && "ignored" in e && e.ignored)).toBe(true); expect(events.some((e) => e.type === "host_process_death")).toBe(true); expect(events.at(-1)?.type).toBe("session_closed"); });
  it("converts AHP events to history JSONL", async () => { const result = await collect_history({ mode: "fixture" }); expect(result.mode).toBe("fixture"); expect(result.target).toBe("vscode-agent-host"); expect(result.history.some((e) => e.op === "approval.grant")).toBe(true); expect(result.history.some((e) => e.fault === "runtime.restart" && e.op == null)).toBe(true); expect(result.history_jsonl.split("\n").filter(Boolean).length).toBe(result.history.length); });
  it("LIVE without AHP_WS_URL fails closed", async () => { await expect(collect_history({ mode: "live", env: {} })).rejects.toThrow(/AHP_WS_URL/); });
  it("digests are deterministic", () => { const a = ahp_events_to_history(new MockAhpPeer().run_fixture_scenario()); const b = ahp_events_to_history(new MockAhpPeer().run_fixture_scenario()); expect(a.find((e) => e.op === "action.bind")?.attrs?.action_digest).toBe(b.find((e) => e.op === "action.bind")?.attrs?.action_digest); });
});

describe("PR-5 action_digest collision + consistency", () => {
  it("Aa vs BB input field collision regression: digests must differ", () => {
    const sid = "ahp-col";
    const events = [
      { type: "tool_confirmation_request" as const, sessionId: sid, requestId: "r-aa", toolName: "Write", input: { path: "/ws/a.txt", content: "Aa" } },
      { type: "tool_confirmation_request" as const, sessionId: sid, requestId: "r-bb", toolName: "Write", input: { path: "/ws/a.txt", content: "BB" } },
    ];
    const history = ahp_events_to_history(events);
    const binds = history.filter((e) => e.op === "action.bind");
    expect(binds).toHaveLength(2);
    expect(binds[0]!.attrs!.action_digest).not.toBe(binds[1]!.attrs!.action_digest);
  });

  it("every action.bind action_digest matches core action_digest of bind attrs", async () => {
    const { action_digest } = await import("@asa/core");
    const history = ahp_events_to_history(new MockAhpPeer().run_fixture_scenario());
    for (const e of history.filter((x) => x.op === "action.bind")) {
      const a = e.attrs!;
      expect(a.action_digest).toBe(
        action_digest({
          action_type: String(a.action_type),
          target: String(a.target),
          args: a.args,
          policy_version: (a.policy_version as string | null | undefined) ?? null,
        }),
      );
    }
  });
});

describe("PR-10c G: leading adapter-header field_provenance (per field, like ACP)", () => {
  const expected = [
      { op: "generation.observe", fp: { ts: "derived", runtime_generation: "derived" } },
      { op: "session.attach", fp: { ts: "derived" } },
  ];
  it("collect_history fixture: leading events carry per-field field_provenance; no other event gains it", async () => {
    const { collect_history: collect } = await import("../src/index.js");
    const result = await collect({ mode: "fixture" });
    expected.forEach((x, i) => {
      expect(result.history[i]!.op).toBe(x.op);
      expect(result.history[i]!.attrs?.field_provenance).toEqual(x.fp);
    });
    expect(result.history.slice(expected.length).filter((e) => e.attrs?.field_provenance !== undefined)).toEqual([]);
  });
  it("committed targets/vscode-agent-host/results/history-fixture.jsonl matches (fixture not regenerated, only provenance added)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../targets/vscode-agent-host/results/history-fixture.jsonl");
    const rows = fs.readFileSync(file, "utf8").trimEnd().split("\n").map((l) => JSON.parse(l) as { op?: string; attrs?: Record<string, unknown> });
    expected.forEach((x, i) => {
      expect(rows[i]!.op).toBe(x.op);
      expect(rows[i]!.attrs?.field_provenance).toEqual(x.fp);
    });
    expect(rows.slice(expected.length).filter((e) => e.attrs?.field_provenance !== undefined)).toEqual([]);
  });
});
