import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
    expect(receipt?.attrs).not.toHaveProperty("action_digest");
    expect(receipt?.attrs?.effect_id).toBe("fs:repo/leftover.txt");
  });

  it("stale-grant orphan reply becomes approval.record not approval.grant", () => {
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
    expect(grants.length).toBe(1);
    expect(grants[0]?.attrs?.runtime_generation).toBe(1);
    expect(grants[0]?.attrs?.request_runtime_generation).toBe(1);
    const records = history.filter((e) => e.op === "approval.record");
    expect(records.length).toBe(1);
    expect(records[0]?.attrs?.decision).toBe("grant");
    expect(records[0]?.attrs?.orphan).toBe(true);
    expect(records[0]?.attrs?.acknowledged).toBe("unknown");
    expect(records[0]?.attrs?.runtime_generation).toBe(2);
    expect(records[0]?.attrs?.request_runtime_generation).toBe(1);
    expect(records[0]?.attrs?.option_id).toBe("allow_once");
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

  it("live-shaped: title toolName + absolute file_path binds relative wait receipt", () => {
    const abs = "/tmp/asa-probe/asa-x.txt";
    const events = [
      {
        type: "session_update" as const,
        sessionId: "s-live",
        update: { kind: "session_new", cwd: "/tmp/asa-probe" },
      },
      {
        type: "permission_request" as const,
        sessionId: "s-live",
        requestId: "r-live",
        toolName: "Write asa-x.txt",
        toolCallId: "tc-live-x",
        input: { file_path: abs, content: "hello-x" },
      },
      {
        type: "permission_response" as const,
        sessionId: "s-live",
        requestId: "r-live",
        decision: "allow" as const,
      },
      {
        type: "session_update" as const,
        sessionId: "s-live",
        update: {
          kind: "effect_receipt",
          sink: "wait_for_write_effect",
          path: "asa-x.txt", // relative — must resolve against session cwd
          present: true,
          matched: true,
          expected: "hello-x",
          content: "hello-x",
        },
      },
    ];
    const history = acp_events_to_history(events);
    const bind = history.find((e) => e.op === "action.bind");
    expect(bind?.attrs?.target).toBe(abs);
    const receipt = history.find((e) => e.op === "effect.receipt");
    expect(receipt?.attrs?.path).toBe(abs);
    expect(receipt?.attrs?.action_digest).toBe(bind?.attrs?.action_digest);
    expect(receipt?.attrs?.action_digest).toBeTruthy();
    expect(receipt?.attrs?.tool_call_id).toBe("tc-live-x");
    expect(receipt?.attrs?.outcome).toBe("committed");
    expect(receipt?.attrs).not.toHaveProperty("binding");
  });

  it("A: absent wait then new grant then present → two receipts; second committed after second grant", () => {
    const events = [
      {
        type: "permission_request" as const,
        sessionId: "s-a",
        requestId: "r1",
        toolName: "Write",
        toolCallId: "tc-a1",
        input: { path: "repo/a.txt", content: "v1" },
      },
      {
        type: "permission_response" as const,
        sessionId: "s-a",
        requestId: "r1",
        decision: "allow" as const,
      },
      {
        type: "session_update" as const,
        sessionId: "s-a",
        update: {
          kind: "effect_receipt",
          sink: "wait_for_write_effect",
          path: "repo/a.txt",
          present: false,
          absent: true,
        },
      },
      {
        type: "permission_request" as const,
        sessionId: "s-a",
        requestId: "r2",
        toolName: "Write",
        toolCallId: "tc-a2",
        input: { path: "repo/a.txt", content: "v2" },
      },
      {
        type: "permission_response" as const,
        sessionId: "s-a",
        requestId: "r2",
        decision: "allow" as const,
      },
      {
        type: "session_update" as const,
        sessionId: "s-a",
        update: {
          kind: "effect_receipt",
          sink: "wait_for_write_effect",
          path: "repo/a.txt",
          present: true,
          matched: true,
          expected: "v2",
          content: "v2",
        },
      },
    ];
    const history = acp_events_to_history(events);
    const receipts = history.filter((e) => e.op === "effect.receipt");
    expect(receipts.length).toBe(2);
    expect(receipts[0]?.attrs?.outcome).toBe("unknown");
    expect(receipts[0]?.attrs?.reason).toBe("file_absent");
    expect(receipts[1]?.attrs?.outcome).toBe("committed");
    expect(receipts[1]?.attrs?.tool_call_id).toBe("tc-a2");
    const grant2 = history.filter((e) => e.op === "approval.grant")[1];
    expect(grant2).toBeTruthy();
    expect(receipts[1]!.seq).toBeGreaterThan(grant2!.seq);
    // First receipt must remain unchanged (no mutation of emitted events)
    expect(receipts[0]?.attrs?.outcome).toBe("unknown");
    expect(receipts[0]?.attrs?.reason).toBe("file_absent");
  });

  it("B: wait absent then adjacent direct_fs_read matched → not file_absent", () => {
    const events = [
      {
        type: "permission_request" as const,
        sessionId: "s-b",
        requestId: "r-b",
        toolName: "Write",
        toolCallId: "tc-b",
        input: { path: "repo/b.txt", content: "body" },
      },
      {
        type: "permission_response" as const,
        sessionId: "s-b",
        requestId: "r-b",
        decision: "allow" as const,
      },
      {
        type: "session_update" as const,
        sessionId: "s-b",
        update: {
          kind: "effect_receipt",
          sink: "wait_for_write_effect",
          path: "repo/b.txt",
          present: false,
          absent: true,
        },
      },
      {
        type: "session_update" as const,
        sessionId: "s-b",
        update: {
          kind: "effect_receipt",
          sink: "direct_fs_read",
          path: "repo/b.txt",
          present: true,
          matched: true,
          expected: "body",
          content: "body",
        },
      },
    ];
    const history = acp_events_to_history(events);
    const receipts = history.filter((e) => e.op === "effect.receipt");
    // Adjacent merge OR new receipt both OK — final result must not be file_absent
    const last = receipts[receipts.length - 1]!;
    expect(last.attrs?.outcome).toBe("committed");
    expect(last.attrs?.reason).not.toBe("file_absent");
    if (receipts.length === 1) {
      expect(receipts[0]?.attrs?.sources).toEqual(["wait_for_write_effect", "direct_fs_read"]);
    }
  });

  it("observed_at_ms: two events ≥5ms apart convert to distinct ordered ts_unix_nano", async () => {
    const t0 = 1_700_000_000_000;
    const events = [
      {
        type: "permission_request" as const,
        sessionId: "s-obs",
        requestId: "r1",
        toolName: "Write",
        toolCallId: "tc-obs-1",
        input: { path: "repo/a.txt", content: "a" },
        observed_at_ms: t0,
      },
      {
        type: "permission_response" as const,
        sessionId: "s-obs",
        requestId: "r1",
        decision: "allow" as const,
        observed_at_ms: t0 + 5,
      },
    ];
    const history = acp_events_to_history(events);
    const bind = history.find((e) => e.op === "action.bind");
    const grant = history.find((e) => e.op === "approval.grant");
    expect(bind?.ts_unix_nano).toBeTruthy();
    expect(grant?.ts_unix_nano).toBeTruthy();
    expect(bind!.ts_unix_nano).not.toBe(grant!.ts_unix_nano);
    expect(BigInt(bind!.ts_unix_nano!)).toBeLessThan(BigInt(grant!.ts_unix_nano!));
    expect(bind!.seq).toBeLessThan(grant!.seq);
    // Mock peer stamps observed_at_ms at push
    const peer = new MockAcpPeer({ sessionId: "s-stamp" });
    const stamped = peer.run_fixture_scenario();
    expect(stamped.every((e) => typeof e.observed_at_ms === "number")).toBe(true);
  });

  it("missing observed_at_ms → conversion-time ts and attrs.field_provenance.ts=derived", () => {
    const events = [
      {
        type: "session_update" as const,
        sessionId: "s-derived",
        update: { kind: "agent_message_chunk", text: "hi" },
        // no observed_at_ms
      },
    ];
    const history = acp_events_to_history(events);
    const upd = history.find((e) => e.attrs?.update_kind === "agent_message_chunk");
    expect(upd?.ts_unix_nano).toBeTruthy();
    expect(upd?.attrs?.field_provenance).toMatchObject({ ts: "derived" });
  });

  it("bind target: path-normalize only for file_path/path; toolName stays raw with target_kind", () => {
    const with_path = acp_events_to_history(
      [
        {
          type: "permission_request" as const,
          sessionId: "s-path",
          requestId: "r1",
          toolName: "Write asa-x.txt",
          input: { file_path: "/tmp/asa-probe/asa-x.txt", content: "x" },
        },
      ],
      { session_cwd: "/tmp/asa-probe" },
    );
    const bind_path = with_path.find((e) => e.op === "action.bind");
    expect(bind_path?.attrs?.target).toBe("/tmp/asa-probe/asa-x.txt");
    expect(bind_path?.attrs?.target_kind).toBe("path");

    const tool_only = acp_events_to_history([
      {
        type: "permission_request" as const,
        sessionId: "s-tool",
        requestId: "r2",
        toolName: "Write asa-x.txt",
        input: { content: "x" },
      },
    ]);
    const bind_tool = tool_only.find((e) => e.op === "action.bind");
    expect(bind_tool?.attrs?.target).toBe("Write asa-x.txt");
    expect(bind_tool?.attrs?.target_kind).toBe("tool_name");
  });

  it("win32 only: case-insensitive compare of action.bind target vs receipt path", () => {
    const desc = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const events = [
        {
          type: "permission_request" as const,
          sessionId: "s-win",
          requestId: "r-win",
          toolName: "Write",
          toolCallId: "tc-win",
          input: { path: "C:/Probe/Asa-X.txt", content: "hello" },
        },
        {
          type: "permission_response" as const,
          sessionId: "s-win",
          requestId: "r-win",
          decision: "allow" as const,
        },
        {
          type: "session_update" as const,
          sessionId: "s-win",
          update: {
            kind: "effect_receipt",
            sink: "wait_for_write_effect",
            path: "c:/probe/asa-x.txt",
            present: true,
            matched: true,
            expected: "hello",
            content: "hello",
          },
        },
      ];
      const history = acp_events_to_history(events);
      const bind = history.find((e) => e.op === "action.bind");
      const receipt = history.find((e) => e.op === "effect.receipt");
      expect(receipt?.attrs?.action_digest).toBe(bind?.attrs?.action_digest);
      expect(receipt?.attrs?.action_digest).toBeTruthy();
      expect(receipt?.attrs?.outcome).toBe("committed");
    } finally {
      if (desc) Object.defineProperty(process, "platform", desc);
      else Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    }
  });


  it("restart fixture with observed_at_ms ~10s past: history ts_unix_nano non-decreasing with seq", () => {
    const peer = new MockAcpPeer({ sessionId: "s-restart-ts" });
    const raw = peer.run_restart_fixture_scenario();
    const shift_ms = 10_000;
    const conversion_approx = Date.now();
    const shifted = raw.map((e) => ({
      ...e,
      observed_at_ms:
        (typeof e.observed_at_ms === "number" ? e.observed_at_ms : conversion_approx) - shift_ms,
    }));
    // Sanity: all peer stamps sit ~10s before conversion time
    for (const e of shifted) {
      expect(e.observed_at_ms!).toBeLessThan(conversion_approx - 5_000);
    }
    const history = acp_events_to_history(shifted);
    expect(history.length).toBeGreaterThan(3);
    for (let i = 1; i < history.length; i++) {
      const prev = history[i - 1]!;
      const cur = history[i]!;
      expect(prev.ts_unix_nano, `seq ${prev.seq} missing ts_unix_nano`).toBeTruthy();
      expect(cur.ts_unix_nano, `seq ${cur.seq} missing ts_unix_nano`).toBeTruthy();
      expect(
        BigInt(cur.ts_unix_nano!),
        `ts_unix_nano not non-decreasing at seq ${prev.seq}→${cur.seq}: ${prev.ts_unix_nano} > ${cur.ts_unix_nano}`,
      ).toBeGreaterThanOrEqual(BigInt(prev.ts_unix_nano!));
    }
    // Header observe/attach must mark ts as derived (synthetic, not a peer observation)
    const header_observe = history.find((e) => e.op === "generation.observe");
    const header_attach = history.find((e) => e.op === "session.attach");
    expect(header_observe?.attrs?.field_provenance).toMatchObject({ ts: "derived" });
    expect(header_attach?.attrs?.field_provenance).toMatchObject({ ts: "derived" });
  });


});

describe("acp-shaped corpus regeneration", () => {
  it("regenerated a1–a6 match committed files (ignore ts/ts_unix_nano)", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repo = path.resolve(here, "../../../..");
    const dir = path.join(repo, "corpus", "acp-shaped");
    const names = [
      "a1-reask-after-restart.jsonl",
      "a2-stale-grant-no-reask.jsonl",
      "a3-deny-then-committed.jsonl",
      "a4-no-request-committed.jsonl",
      "a5-unknown-only.jsonl",
      "a6-orphan-only.jsonl",
    ];
    const before: Record<string, string> = {};
    for (const name of names) {
      before[name] = fs.readFileSync(path.join(dir, name), "utf8");
    }
    execFileSync("pnpm", ["exec", "tsx", "scripts/generate-acp-shaped-corpus.ts"], {
      cwd: repo,
      stdio: "pipe",
    });
    const strip_ts = (line: string): string => {
      const o = JSON.parse(line) as Record<string, unknown>;
      delete o.ts;
      delete o.ts_unix_nano;
      return JSON.stringify(o);
    };
    for (const [name, prev] of Object.entries(before)) {
      const next = fs.readFileSync(path.join(dir, name), "utf8");
      const prev_lines = prev.trim().split("\n").map(strip_ts);
      const next_lines = next.trim().split("\n").map(strip_ts);
      expect(next_lines).toEqual(prev_lines);
    }
  });
});
