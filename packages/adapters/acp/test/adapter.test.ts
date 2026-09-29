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
  pick_allow_always_option_id,
  pick_allow_always_option,
  pick_reject_always_option_id,
  pick_reject_always_option,
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

  it("prefers allow_always / allow-with-updates for always-grant picker", () => {
    expect(
      pick_allow_always_option_id([
        { optionId: "allow-once", kind: "allow_once" },
        { optionId: "allow-with-updates", kind: "allow_always" },
        { optionId: "reject", kind: "reject_once" },
      ]),
    ).toBe("allow-with-updates");
    expect(
      pick_allow_always_option([
        { optionId: "allow-always", kind: "allow_always" },
        { optionId: "allow-once", kind: "allow_once" },
      ]),
    ).toEqual({ id: "allow-always", kind: "allow_always" });
    expect(
      pick_allow_always_option_id([
        { optionId: "allow-once", kind: "allow_once" },
        { optionId: "reject", kind: "reject_once" },
      ]),
    ).toBeUndefined();
    expect(pick_allow_always_option_id([{ optionId: "allow-once", kind: "allow_once" }])).toBeUndefined();
  });


  it("prefers reject_always strictly and never falls back to reject_once", () => {
    expect(
      pick_reject_always_option_id([
        { optionId: "allow-once", kind: "allow_once" },
        { optionId: "reject", kind: "reject_once" },
        { optionId: "reject-always", kind: "reject_always" },
      ]),
    ).toBe("reject-always");
    expect(
      pick_reject_always_option([
        { optionId: "reject_always", kind: "reject_always" },
        { optionId: "reject", kind: "reject_once" },
      ]),
    ).toEqual({ id: "reject_always", kind: "reject_always" });
    expect(
      pick_reject_always_option_id([
        { optionId: "allow-once", kind: "allow_once" },
        { optionId: "reject", kind: "reject_once" },
      ]),
    ).toBeUndefined();
    expect(pick_reject_always_option_id([{ optionId: "reject", kind: "reject_once" }])).toBeUndefined();
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

  it("records option_id/kind on approval.grant when present", () => {
    const peer = new MockAcpPeer();
    const history = acp_events_to_history(peer.run_fixture_scenario());
    const grant = history.find((e) => e.op === "approval.grant");
    expect(grant?.attrs?.option_id).toBe("allow-once");
    expect(grant?.attrs?.option_kind).toBe("allow_once");
    const req = history.find((e) => e.op === "approval.request");
    expect(Array.isArray(req?.attrs?.offered_options)).toBe(true);
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

  it("accepts always-grant scenario in fixture mode without live peer", async () => {
    const result = await collect_history({ mode: "fixture", scenario: "always-grant" });
    expect(result.mode).toBe("fixture");
    expect(result.package_version_pinned).toBe("0.75.1");
    expect(result.history.length).toBeGreaterThan(3);
    expect(result.notes.some((n) => /always-grant/i.test(n))).toBe(true);
    const grant = result.history.find((e) => e.op === "approval.grant");
    expect(grant?.attrs?.option_id).toBeDefined();
  });

  it("accepts reject-always scenario in fixture mode without live peer", async () => {
    const result = await collect_history({ mode: "fixture", scenario: "reject-always" });
    expect(result.mode).toBe("fixture");
    expect(result.package_version_pinned).toBe("0.75.1");
    expect(result.history.length).toBeGreaterThan(3);
    expect(result.notes.some((n) => /reject-always/i.test(n))).toBe(true);
  });

  it("multi-generation restart fixture emits fault, gen bump, digest-linked approvals, and effect receipts", () => {
    const peer = new MockAcpPeer({ sessionId: "s-restart" });
    const history = acp_events_to_history(peer.run_restart_fixture_scenario());

    const faults = history.filter((e) => e.kind === "fault" && e.fault === "runtime.restart");
    expect(faults.length).toBe(1);

    const gens = history.filter((e) => e.op === "generation.observe");
    expect(gens.length).toBe(2);
    expect(gens[0]?.attrs?.runtime_generation).toBe(1);
    expect(gens[1]?.attrs?.runtime_generation).toBe(2);

    const binds = history.filter((e) => e.op === "action.bind");
    expect(binds.length).toBe(2);
    expect(binds[0]?.attrs?.runtime_generation).toBe(1);
    expect(binds[1]?.attrs?.runtime_generation).toBe(2);

    const grants = history.filter((e) => e.op === "approval.grant");
    expect(grants.length).toBe(2);
    for (const g of grants) {
      const req = history.find(
        (e) => e.op === "approval.request" && e.attrs?.request_id === g.attrs?.request_id,
      );
      expect(req).toBeTruthy();
      expect(g.attrs?.action_digest).toBe(req?.attrs?.action_digest);
      expect(g.attrs?.action_digest).toBeTruthy();
    }
    expect(grants[0]?.attrs?.runtime_generation).toBe(1);
    expect(grants[0]?.attrs?.request_runtime_generation).toBe(1);
    expect(grants[1]?.attrs?.runtime_generation).toBe(2);
    expect(grants[1]?.attrs?.request_runtime_generation).toBe(2);

    const receipts = history.filter((e) => e.op === "effect.receipt");
    expect(receipts.length).toBe(2);
    for (const r of receipts) {
      expect(r.attrs?.outcome).toBe("committed");
      expect(r.attrs?.field_provenance).toMatchObject({ outcome: "derived" });
      expect(r.attrs?.action_digest).toBeTruthy();
      expect(r.attrs?.sources).toEqual(["fixture_fs"]);
    }
    expect(receipts[0]?.attrs?.runtime_generation).toBe(1);
    expect(receipts[0]?.attrs?.effect_id).toBe("tc-gen1");
    expect(receipts[1]?.attrs?.runtime_generation).toBe(2);
    expect(receipts[1]?.attrs?.effect_id).toBe("tc-gen2");
  });

  it("links approval.grant action_digest via request_id on single-generation fixture", () => {
    const peer = new MockAcpPeer();
    const history = acp_events_to_history(peer.run_fixture_scenario());
    const grant = history.find((e) => e.op === "approval.grant");
    const req = history.find((e) => e.op === "approval.request");
    expect(grant?.attrs?.action_digest).toBe(req?.attrs?.action_digest);
    expect(grant?.attrs?.runtime_generation).toBe(1);
    const receipt = history.find((e) => e.op === "effect.receipt");
    expect(receipt?.attrs?.outcome).toBe("committed");
    expect(receipt?.attrs?.field_provenance).toMatchObject({ outcome: "derived" });
  });

  it("effect.receipt is unknown with reason when wait fixture reports absent file", () => {
    const events = [
      {
        type: "session_update" as const,
        sessionId: "s-absent",
        update: {
          kind: "effect_receipt",
          sink: "wait_for_write_effect",
          path: "repo/missing.txt",
          present: false,
          absent: true,
        },
      },
    ];
    const history = acp_events_to_history(events);
    const receipt = history.find((e) => e.op === "effect.receipt");
    expect(receipt?.attrs?.outcome).toBe("unknown");
    expect(receipt?.attrs?.reason).toBe("file_absent");
    expect(receipt?.attrs?.field_provenance).toMatchObject({ outcome: "derived" });
  });

});

  it("content mismatch → effect.receipt unknown with reason content_mismatch", () => {
    const events = [
      {
        type: "permission_request" as const,
        sessionId: "s-mm",
        requestId: "r1",
        toolName: "Write",
        toolCallId: "tc-mm",
        input: { path: "repo/mismatch.txt", content: "expected" },
      },
      {
        type: "permission_response" as const,
        sessionId: "s-mm",
        requestId: "r1",
        decision: "allow" as const,
      },
      {
        type: "session_update" as const,
        sessionId: "s-mm",
        update: {
          kind: "effect_receipt",
          sink: "wait_for_write_effect",
          path: "repo/mismatch.txt",
          present: true,
          matched: false,
          expected: "expected",
          content: "leftover-other",
        },
      },
    ];
    const history = acp_events_to_history(events);
    const receipt = history.find((e) => e.op === "effect.receipt");
    expect(receipt?.attrs?.outcome).toBe("unknown");
    expect(receipt?.attrs?.reason).toBe("content_mismatch");
    expect(receipt?.attrs?.action_digest).toBeTruthy();
    expect(receipt?.attrs?.effect_id).toBe("tc-mm");
  });

  it("leftover old file present without content compare → content_not_verified not committed", () => {
    const events = [
      {
        type: "session_update" as const,
        sessionId: "s-left",
        update: {
          kind: "effect_receipt",
          sink: "wait_for_write_effect",
          path: "repo/leftover.txt",
          present: true,
          // no matched / expected — file exists from a prior run
        },
      },
    ];
    const history = acp_events_to_history(events);
    const receipt = history.find((e) => e.op === "effect.receipt");
    expect(receipt?.attrs?.outcome).toBe("unknown");
    expect(receipt?.attrs?.reason).toBe("content_not_verified");
    expect(receipt?.attrs?.binding).toBe("unlinked");
    expect(receipt?.attrs?.action_digest).toBe("");
    expect(receipt?.attrs?.effect_id).toBe("fs:repo/leftover.txt");
  });

  it("stale-grant reply to old request records permission_response with dual generation attrs", () => {
    const events = [
      {
        type: "permission_request" as const,
        sessionId: "s-stale",
        requestId: "old-req",
        toolName: "Write",
        toolCallId: "tc-old",
        input: { path: "repo/stale.txt", content: "v1" },
      },
      {
        type: "permission_response" as const,
        sessionId: "s-stale",
        requestId: "old-req",
        decision: "allow" as const,
        optionId: "allow_once",
        optionKind: "allow_once",
      },
      {
        type: "runtime_restart" as const,
        sessionId: "s-stale",
        reason: "SIGTERM_gen1",
      },
      // Orphan allow_once for the gen1 requestId after restart (stale-grant probe)
      {
        type: "permission_response" as const,
        sessionId: "s-stale",
        requestId: "old-req",
        decision: "allow" as const,
        optionId: "allow_once",
        optionKind: "allow_once",
      },
    ];
    const history = acp_events_to_history(events);
    const grants = history.filter((e) => e.op === "approval.grant");
    expect(grants.length).toBe(2);
    expect(grants[0]?.attrs?.runtime_generation).toBe(1);
    expect(grants[0]?.attrs?.request_runtime_generation).toBe(1);
    // Decision made in gen2 for a gen1 request
    expect(grants[1]?.attrs?.runtime_generation).toBe(2);
    expect(grants[1]?.attrs?.request_runtime_generation).toBe(1);
    expect(grants[1]?.attrs?.option_id).toBe("allow_once");
  });

  it("dual-source observation same path merges into one effect.receipt with attrs.sources", () => {
    const events = [
      {
        type: "permission_request" as const,
        sessionId: "s-dual",
        requestId: "r-dual",
        toolName: "Write",
        toolCallId: "tc-dual",
        input: { path: "repo/dual.txt", content: "dual" },
      },
      {
        type: "permission_response" as const,
        sessionId: "s-dual",
        requestId: "r-dual",
        decision: "allow" as const,
      },
      {
        type: "session_update" as const,
        sessionId: "s-dual",
        update: {
          kind: "effect_receipt",
          sink: "wait_for_write_effect",
          path: "repo/dual.txt",
          present: true,
          matched: true,
          expected: "dual",
          content: "dual",
        },
      },
      {
        type: "session_update" as const,
        sessionId: "s-dual",
        update: {
          kind: "effect_receipt",
          sink: "direct_fs_read",
          path: "repo/dual.txt",
          present: true,
          matched: true,
          expected: "dual",
          content: "dual",
        },
      },
    ];
    const history = acp_events_to_history(events);
    const receipts = history.filter((e) => e.op === "effect.receipt");
    expect(receipts.length).toBe(1);
    expect(receipts[0]?.attrs?.outcome).toBe("committed");
    expect(receipts[0]?.attrs?.sources).toEqual(["wait_for_write_effect", "direct_fs_read"]);
    expect(receipts[0]?.attrs?.effect_id).toBe("tc-dual");
    expect(receipts[0]?.attrs?.action_digest).toBeTruthy();
    expect(receipts[0]?.attrs?.tool_call_id).toBe("tc-dual");
  });
