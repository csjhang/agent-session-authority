import{describe,expect,it}from"vitest";
import{collect_history,MockAcpMuxPeer,acp_mux_events_to_history}from"../src/index.js";
describe("@asa/adapter-acp-mux fixture",()=>{
  it("models observation attach and reissue",()=>{const e=new MockAcpMuxPeer().run_fixture_scenario();expect(e.some(x=>x.type==="observer_attach")).toBe(true);expect(e.some(x=>x.type==="pending_permission_reissue")).toBe(true);expect(e.some(x=>x.type==="permission_resolved")).toBe(true)});
  it("converts history and notes non-claims",async()=>{const r=await collect_history({mode:"fixture"});expect(r.target).toBe("acp-mux");expect(r.history.some(x=>x.op==="approval.grant")).toBe(true);expect(r.notes.some(n=>/no fencing/i.test(n))).toBe(true)});
  it("LIVE fails closed",async()=>{await expect(collect_history({mode:"live"})).rejects.toThrow(/not implemented/)});
  it("digests deterministic",()=>{const a=acp_mux_events_to_history(new MockAcpMuxPeer().run_fixture_scenario()),b=acp_mux_events_to_history(new MockAcpMuxPeer().run_fixture_scenario());expect(a.find(x=>x.op==="action.bind")?.attrs?.action_digest).toBe(b.find(x=>x.op==="action.bind")?.attrs?.action_digest)});
});

describe("PR-5 action_digest collision + consistency", () => {
  it("Aa vs BB input field collision regression: digests must differ", () => {
    const sid = "mux-col";
    const events = [
      { type: "permission_request" as const, sessionId: sid, requestId: "r-aa", toolName: "Write", input: { path: "/ws/a.txt", content: "Aa" }, pending: true as const },
      { type: "permission_request" as const, sessionId: sid, requestId: "r-bb", toolName: "Write", input: { path: "/ws/a.txt", content: "BB" }, pending: true as const },
    ];
    const history = acp_mux_events_to_history(events);
    const binds = history.filter((e) => e.op === "action.bind");
    expect(binds).toHaveLength(2);
    expect(binds[0]!.attrs!.action_digest).not.toBe(binds[1]!.attrs!.action_digest);
  });

  it("every action.bind action_digest matches core action_digest of bind attrs", async () => {
    const { action_digest } = await import("@asa/core");
    const history = acp_mux_events_to_history(new MockAcpMuxPeer().run_fixture_scenario());
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
