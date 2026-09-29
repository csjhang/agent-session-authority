/**
 * Offline live-path tests against test/fixtures/fake-acp-agent.mjs.
 * Never spawns real claude-agent-acp or calls the Anthropic API.
 *
 * Imports only modules that already exist on main so this file loads before
 * the implementation commit (assertions fail; load does not).
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse_history_jsonl, run_checkers, default_assessment } from "@asa/core";
import { collect_history, acp_events_to_history } from "../src/index.js";
import { wait_for_write_effect } from "../src/effect_wait.js";
import type { AcpPeerEvent } from "../src/mock_peer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fake_agent = path.join(here, "fixtures", "fake-acp-agent.mjs");

function tmp_dir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `asa-pr6f-${label}-`));
}

function fake_env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ANTHROPIC_API_KEY: "offline-fake-agent-placeholder",
    ...extra,
  };
}

function live_opts(
  scenario: "effect" | "always-grant" | "reject-always" | "stale-effect",
  cwd: string,
  extra_env: Record<string, string> = {},
) {
  return {
    mode: "live" as const,
    scenario,
    cwd,
    live_command: process.execPath,
    live_args: [fake_agent],
    env: fake_env(extra_env),
    effect_grace_ms: 3000,
    always_grant_poll_ms: 3000,
    live_observe_ms: 5000,
  };
}

describe("live harness with offline fake-acp-agent.mjs", () => {
  it(
    "effect scenario: file lands 1.5s after tool completion → both generations committed and wait notes waited_ms≥1000",
    async () => {
      const cwd = tmp_dir("delay");
      const result = await collect_history({
        ...live_opts("effect", cwd, { ASA_FAKE_WRITE_DELAY_MS: "1500" }),
        effect_grace_ms: 6000,
        always_grant_poll_ms: 6000,
      });
      const receipts = result.history.filter((e) => e.op === "effect.receipt");
      const committed = receipts.filter((e) => e.attrs?.outcome === "committed");
      expect(committed.length).toBeGreaterThanOrEqual(2);
      const wait_notes = result.notes.filter((n) => n.startsWith("wait_for_write_effect("));
      expect(wait_notes.length).toBeGreaterThanOrEqual(2);
      for (const n of wait_notes.slice(0, 2)) {
        const m = /waited_ms=(\d+)/.exec(n);
        expect(m, n).toBeTruthy();
        expect(Number(m![1]), n).toBeGreaterThanOrEqual(1000);
      }
    },
    30000,
  );

  it(
    "effect scenario: session cwd differs from process.cwd() → both receipts committed and cwd has two asa-effect- files",
    async () => {
      const cwd = tmp_dir("cwd-diff");
      expect(path.resolve(cwd)).not.toBe(path.resolve(process.cwd()));
      const result = await collect_history(live_opts("effect", cwd));
      const receipts = result.history.filter((e) => e.op === "effect.receipt");
      const committed = receipts.filter((e) => e.attrs?.outcome === "committed");
      expect(committed.length).toBeGreaterThanOrEqual(2);
      const files = fs.readdirSync(cwd).filter((f) => f.startsWith("asa-effect-"));
      expect(files.length).toBe(2);
    },
    30000,
  );

  it(
    "always-grant with ASA_FAKE_OPTIONS=no_always → approval.record decision cancelled reason allow_always_option_absent; no approval.deny",
    async () => {
      const cwd = tmp_dir("no-always");
      const result = await collect_history(
        live_opts("always-grant", cwd, { ASA_FAKE_OPTIONS: "no_always" }),
      );
      const records = result.history.filter((e) => e.op === "approval.record");
      const cancelled = records.filter(
        (e) =>
          e.attrs?.decision === "cancelled" &&
          e.attrs?.client_outcome === "cancelled" &&
          e.attrs?.reason === "allow_always_option_absent",
      );
      expect(cancelled.length).toBeGreaterThanOrEqual(1);
      const gen1_req = result.history.find((e) => e.op === "approval.request");
      expect(gen1_req).toBeTruthy();
      const matched = cancelled.find((e) => e.attrs?.request_id === gen1_req!.attrs?.request_id);
      expect(matched).toBeTruthy();
      expect(result.history.filter((e) => e.op === "approval.deny")).toHaveLength(0);
    },
    30000,
  );

  it(
    "reject-always with default options (no reject_always) → approval.record decision cancelled reason reject_always_option_absent; no approval.deny",
    async () => {
      const cwd = tmp_dir("no-reject-always");
      const result = await collect_history(live_opts("reject-always", cwd));
      const cancelled = result.history.filter(
        (e) =>
          e.op === "approval.record" &&
          e.attrs?.decision === "cancelled" &&
          e.attrs?.reason === "reject_always_option_absent",
      );
      expect(cancelled.length).toBeGreaterThanOrEqual(1);
      expect(result.history.filter((e) => e.op === "approval.deny")).toHaveLength(0);
    },
    30000,
  );

  it(
    "ASA_FAKE_VERSION=0.75.0 → run_valid false, package_version_observed 0.75.0, invalid_reasons pin mismatch; no approval.request or prompt_result",
    async () => {
      const cwd = tmp_dir("ver-old");
      const result = await collect_history(
        live_opts("effect", cwd, { ASA_FAKE_VERSION: "0.75.0" }),
      );
      expect(result.run_valid).toBe(false);
      expect(result.package_version_observed).toBe("0.75.0");
      expect(result.invalid_reasons.some((r) => /0\.75\.0 != pinned 0\.75\.1/.test(r))).toBe(true);
      expect(result.history.filter((e) => e.op === "approval.request")).toHaveLength(0);
      expect(
        result.events.filter(
          (e) => e.type === "session_update" && e.update.kind === "prompt_result",
        ),
      ).toHaveLength(0);
    },
    30000,
  );

  it(
    "ASA_FAKE_VERSION=none → run_valid false, invalid_reasons contain version=missing",
    async () => {
      const cwd = tmp_dir("ver-none");
      const result = await collect_history(
        live_opts("effect", cwd, { ASA_FAKE_VERSION: "none" }),
      );
      expect(result.run_valid).toBe(false);
      expect(result.invalid_reasons.some((r) => /version=missing/.test(r))).toBe(true);
    },
    30000,
  );

  it(
    "ASA_FAKE_WRITE_VIA_CLIENT=1 → both receipts committed, first sources include acp.fs.write_text_file, two asa-effect- files in cwd",
    async () => {
      const cwd = tmp_dir("via-client");
      const result = await collect_history(
        live_opts("effect", cwd, { ASA_FAKE_WRITE_VIA_CLIENT: "1" }),
      );
      const receipts = result.history.filter((e) => e.op === "effect.receipt");
      const committed = receipts.filter((e) => e.attrs?.outcome === "committed");
      expect(committed.length).toBeGreaterThanOrEqual(2);
      const first = committed[0]!;
      const sources = first.attrs?.sources as string[] | undefined;
      expect(sources ?? [String(first.attrs?.sink)]).toContain("acp.fs.write_text_file");
      expect(fs.readdirSync(cwd).filter((f) => f.startsWith("asa-effect-")).length).toBe(2);
    },
    30000,
  );

  it(
    "ASA_FAKE_WRITE_VIA_CLIENT=1 and ASA_FAKE_ESCAPE_CWD=1 with cwd=tmp/session → refused note; parent tmp has no asa-effect- files",
    async () => {
      const parent = tmp_dir("escape-parent");
      const session = path.join(parent, "session");
      fs.mkdirSync(session);
      const result = await collect_history(
        live_opts("effect", session, {
          ASA_FAKE_WRITE_VIA_CLIENT: "1",
          ASA_FAKE_ESCAPE_CWD: "1",
        }),
      );
      expect(
        result.notes.some((n) => n.startsWith("client fs/write_text_file refused")),
      ).toBe(true);
      const parent_hits = fs
        .readdirSync(parent)
        .filter((f) => f.startsWith("asa-effect-"));
      expect(parent_hits).toHaveLength(0);
    },
    30000,
  );

  it(
    "stale-effect with default options → exactly one approval.deny option_kind reject_once; last effect.receipt unknown with reason file_absent",
    async () => {
      const cwd = tmp_dir("stale-effect");
      const result = await collect_history(live_opts("stale-effect", cwd));
      const denies = result.history.filter((e) => e.op === "approval.deny");
      expect(denies).toHaveLength(1);
      expect(denies[0]?.attrs?.option_kind).toBe("reject_once");
      const receipts = result.history.filter((e) => e.op === "effect.receipt");
      expect(receipts.at(-1)?.attrs?.outcome).toBe("unknown");
      expect(receipts.at(-1)?.attrs?.reason).toBe("file_absent");
    },
    30000,
  );

  it(
    "stale-effect with ASA_FAKE_WRITE_ON_REJECT=1 → AUTH-02 observed_result violation with committed_after_deny",
    async () => {
      const cwd = tmp_dir("write-on-reject");
      const result = await collect_history(
        live_opts("stale-effect", cwd, { ASA_FAKE_WRITE_ON_REJECT: "1" }),
      );
      const events = parse_history_jsonl(result.history_jsonl);
      const assessment = default_assessment();
      assessment.test_basis = "synthetic_fixture";
      const findings = run_checkers(
        events,
        { profile_version: "0.2", claimed_invariants: ["AUTH-02"] },
        assessment,
      );
      const auth02 = findings.find((f) => f.invariant === "AUTH-02");
      expect(auth02?.observed_result).toBe("violation");
      expect(auth02?.explanation).toMatch(/committed_after_deny/);
    },
    30000,
  );

  it(
    "wait_for_write_effect: completed tool_call titled Write asa-other.txt does not match missing asa-target.txt",
    async () => {
      const events: AcpPeerEvent[] = [
        {
          type: "session_update",
          sessionId: "s",
          update: {
            kind: "tool_call_update",
            title: "Write asa-other.txt",
            status: "completed",
          },
        },
      ];
      const notes: string[] = [];
      const started = Date.now();
      const out = await wait_for_write_effect("asa-target.txt", events, notes, {
        grace_ms: 600,
        poll_ms: 100,
        since_index: 0,
        cwd: tmp_dir("wait-other"),
      });
      expect(out.present).toBe(false);
      expect(out.tool_call_completed).toBe(false);
      expect(out.waited_ms).toBeGreaterThanOrEqual(500);
      expect(Date.now() - started).toBeGreaterThanOrEqual(500);
    },
    30000,
  );

  it(
    "wait_for_write_effect: completed event whose title is asa-target.txt but before since_index is ignored",
    async () => {
      const events: AcpPeerEvent[] = [
        {
          type: "session_update",
          sessionId: "s",
          update: {
            kind: "tool_call_update",
            title: "asa-target.txt",
            status: "completed",
          },
        },
        {
          type: "session_update",
          sessionId: "s",
          update: { kind: "agent_message_chunk", text: "later" },
        },
      ];
      const notes: string[] = [];
      const out = await wait_for_write_effect("asa-target.txt", events, notes, {
        grace_ms: 400,
        poll_ms: 50,
        since_index: 1,
        cwd: tmp_dir("wait-since"),
      });
      expect(out.tool_call_completed).toBe(false);
    },
    30000,
  );

  it(
    "acp_events_to_history: bind /ws/A.txt vs receipt /ws/a.txt → receipt binding unlinked on any host",
    () => {
      const events: AcpPeerEvent[] = [
        {
          type: "permission_request",
          sessionId: "s",
          requestId: "r1",
          toolName: "Write",
          toolCallId: "tc1",
          input: { path: "/ws/A.txt", content: "x" },
        },
        {
          type: "permission_response",
          sessionId: "s",
          requestId: "r1",
          decision: "allow",
        },
        {
          type: "session_update",
          sessionId: "s",
          update: {
            kind: "effect_receipt",
            sink: "wait_for_write_effect",
            path: "/ws/a.txt",
            present: true,
            matched: true,
            expected: "x",
            content: "x",
          },
        },
      ];
      const history = acp_events_to_history(events);
      const receipt = history.find((e) => e.op === "effect.receipt");
      expect(receipt?.attrs?.binding).toBe("unlinked");
      expect(receipt?.attrs).not.toHaveProperty("action_digest");
    },
  );

  it(
    "acp_events_to_history: bind C:/ws/A.txt vs receipt C:/ws/a.txt → receipt carries action_digest on any host",
    () => {
      const events: AcpPeerEvent[] = [
        {
          type: "permission_request",
          sessionId: "s",
          requestId: "r1",
          toolName: "Write",
          toolCallId: "tc1",
          input: { path: "C:/ws/A.txt", content: "x" },
        },
        {
          type: "permission_response",
          sessionId: "s",
          requestId: "r1",
          decision: "allow",
        },
        {
          type: "session_update",
          sessionId: "s",
          update: {
            kind: "effect_receipt",
            sink: "wait_for_write_effect",
            path: "C:/ws/a.txt",
            present: true,
            matched: true,
            expected: "x",
            content: "x",
          },
        },
      ];
      const history = acp_events_to_history(events);
      const bind = history.find((e) => e.op === "action.bind");
      const receipt = history.find((e) => e.op === "effect.receipt");
      expect(receipt?.attrs?.action_digest).toBeTruthy();
      expect(receipt?.attrs?.action_digest).toBe(bind?.attrs?.action_digest);
    },
  );

  it(
    "acp_events_to_history: effect_receipt with absent+matched false → outcome unknown reason file_absent",
    () => {
      const events: AcpPeerEvent[] = [
        {
          type: "session_update",
          sessionId: "s",
          update: {
            kind: "effect_receipt",
            sink: "direct_fs_read",
            path: "/ws/missing.txt",
            present: false,
            absent: true,
            matched: false,
            expected: "x",
            content: null,
          },
        },
      ];
      const history = acp_events_to_history(events);
      const receipt = history.find((e) => e.op === "effect.receipt");
      expect(receipt?.attrs?.outcome).toBe("unknown");
      expect(receipt?.attrs?.reason).toBe("file_absent");
    },
  );
});
