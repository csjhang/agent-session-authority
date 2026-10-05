import {describe,expect,it} from "vitest";
import {collect_history,MockAblyPeer,ably_events_to_history} from "../src/index.js";
describe("@asa/adapter-ably fixture",()=>{
  it("models HITL and first response wins",()=>{const e=new MockAblyPeer().run_fixture_scenario();expect(e.some(x=>x.type==="run_suspend")).toBe(true);expect(e.some(x=>x.type==="tool_approval_response"&&"ignored"in x&&x.ignored)).toBe(true);expect(e.some(x=>x.type==="run_resume")).toBe(true)});
  it("converts history",async()=>{const r=await collect_history({mode:"fixture"});expect(r.target).toBe("ably");expect(r.history.some(x=>x.op==="approval.grant")).toBe(true);expect(r.history.some(x=>x.fault==="runtime.restart"&&x.op==null)).toBe(true);expect(r.notes.some(x=>/cloud|air-gap/i.test(x))).toBe(true)});
  it("fails closed without key",async()=>{await expect(collect_history({mode:"live",env:{}})).rejects.toThrow(/ABLY_API_KEY/) });
  it("key still refuses unimplemented capture",async()=>{await expect(collect_history({mode:"live",env:{ABLY_API_KEY:"x:y"}})).rejects.toThrow(/not implemented/) });
  it("digests deterministic",()=>{const a=ably_events_to_history(new MockAblyPeer().run_fixture_scenario()),b=ably_events_to_history(new MockAblyPeer().run_fixture_scenario());expect(a.find(x=>x.op==="action.bind")?.attrs?.action_digest).toBe(b.find(x=>x.op==="action.bind")?.attrs?.action_digest)});
});

describe("PR-5 action_digest collision + consistency", () => {
  it("Aa vs BB input field collision regression: digests must differ", () => {
    const sid = "ably-col";
    const events = [
      { type: "tool_call_pending" as const, sessionId: sid, runId: "run-1", toolCallId: "tc-aa", toolName: "Write", input: { path: "/ws/a.txt", content: "Aa" } },
      { type: "tool_call_pending" as const, sessionId: sid, runId: "run-1", toolCallId: "tc-bb", toolName: "Write", input: { path: "/ws/a.txt", content: "BB" } },
    ];
    const history = ably_events_to_history(events);
    const binds = history.filter((e) => e.op === "action.bind");
    expect(binds).toHaveLength(2);
    expect(binds[0]!.attrs!.action_digest).not.toBe(binds[1]!.attrs!.action_digest);
  });

  it("every action.bind action_digest matches core action_digest of bind attrs", async () => {
    const { action_digest } = await import("@asa/core");
    const history = ably_events_to_history(new MockAblyPeer().run_fixture_scenario());
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
  it("committed targets/ably/results/history-fixture.jsonl matches (fixture not regenerated, only provenance added)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../targets/ably/results/history-fixture.jsonl");
    const rows = fs.readFileSync(file, "utf8").trimEnd().split("\n").map((l) => JSON.parse(l) as { op?: string; attrs?: Record<string, unknown> });
    expected.forEach((x, i) => {
      expect(rows[i]!.op).toBe(x.op);
      expect(rows[i]!.attrs?.field_provenance).toEqual(x.fp);
    });
    expect(rows.slice(expected.length).filter((e) => e.attrs?.field_provenance !== undefined)).toEqual([]);
  });
});
