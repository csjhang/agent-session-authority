/**
 * Offline mid-write-restart: SIGTERM while Write permission is outstanding (before allow).
 * Fail-first: loads against unpatched harness; assertions fail until scenario + fake modes land.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse_history_jsonl, run_checkers, default_assessment } from "@asa/core";
import type { HistoryEvent } from "@asa/core";
import { collect_history } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fake_agent = path.join(here, "fixtures", "fake-acp-agent.mjs");

function tmp_dir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `asa-pr9a-${label}-`));
}

function fake_env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ANTHROPIC_API_KEY: "offline-fake-agent-placeholder",
    ...extra,
  };
}

function mid_write_opts(cwd: string, extra_env: Record<string, string> = {}) {
  return {
    mode: "live" as const,
    scenario: "mid-write-restart" as const,
    cwd,
    live_command: process.execPath,
    live_args: [fake_agent],
    env: fake_env(extra_env),
    effect_grace_ms: 1500,
    always_grant_poll_ms: 1500,
    live_observe_ms: 5000,
  };
}

function auth(history: HistoryEvent[], inv: "AUTH-02" | "AUTH-07") {
  const assessment = default_assessment();
  assessment.test_basis = "research_profile";
  return run_checkers(
    history,
    { profile_version: "0.2", claimed_invariants: [inv] },
    assessment,
  ).find((f) => f.invariant === inv)!;
}

function target_witness_seqs(history: HistoryEvent[], finding: { witness_seqs?: number[] }) {
  const by_seq = new Map(history.map((e) => [e.seq, e]));
  return (finding.witness_seqs ?? []).filter((seq) => {
    const e = by_seq.get(seq);
    return (e?.attrs?.field_provenance as Record<string, unknown> | undefined)?.terminal === "target";
  });
}

describe("mid-write-restart (permission outstanding before allow)", () => {
  it(
    "default/silent: interrupt before allow; gen2 load + disk only; no grant; file absent; AUTH-02 inconclusive; AUTH-07 supported without target_witness",
    async () => {
      const cwd = tmp_dir("silent");
      const result = await collect_history(mid_write_opts(cwd));
      expect(result.run_valid).toBe(true);

      const reqs = result.events.filter((e) => e.type === "permission_request");
      const resps = result.events.filter((e) => e.type === "permission_response");
      expect(reqs.length).toBe(1);
      expect(resps.length).toBe(0);

      expect(result.history.some((e) => e.fault === "runtime.restart")).toBe(true);
      expect(
        result.events.some((e) => e.type === "session_update" && e.update.kind === "session_load"),
      ).toBe(true);

      // No forced gen2 Write — only the interrupted path is probed.
      const write_prompts = result.events.filter(
        (e) =>
          e.type === "session_update" &&
          typeof e.update.kind === "string" &&
          e.update.kind === "prompt_result" &&
          String(e.update.prompt ?? "").includes("post_restart"),
      );
      expect(write_prompts).toHaveLength(0);

      const receipts = result.history.filter((e) => e.op === "effect.receipt");
      expect(receipts.length).toBeGreaterThanOrEqual(1);
      expect(receipts.at(-1)?.attrs?.outcome).toBe("unknown");
      expect(receipts.at(-1)?.attrs?.reason).toBe("file_absent");
      expect(fs.readdirSync(cwd).filter((f) => f.startsWith("asa-mid-write-"))).toHaveLength(0);

      const events = parse_history_jsonl(result.history_jsonl);
      const a02 = auth(events, "AUTH-02");
      const a07 = auth(events, "AUTH-07");
      expect(a02.observed_result).toBe("inconclusive");
      expect(a07.observed_result).toBe("supported");
      // Aggregation target_witness: silent mode has no agent terminal among AUTH-07 witnesses.
      expect(target_witness_seqs(events, a07)).toHaveLength(0);

      expect(result.notes.some((n) => /mid-write-restart/i.test(n) && /outstanding/i.test(n))).toBe(
        true,
      );
    },
    60_000,
  );

  it(
    "ASA_FAKE_REPORT_FAILED_ON_LOAD=1: post-load failed for interrupted id; disk absent; AUTH-07 supported with target_witness",
    async () => {
      const cwd = tmp_dir("failed-on-load");
      const result = await collect_history(
        mid_write_opts(cwd, { ASA_FAKE_REPORT_FAILED_ON_LOAD: "1" }),
      );
      expect(result.run_valid).toBe(true);

      const req = result.events.find((e) => e.type === "permission_request");
      expect(req && req.type === "permission_request").toBe(true);
      const tool_call_id =
        req && req.type === "permission_request" ? req.toolCallId : undefined;
      expect(tool_call_id).toBeTruthy();

      const failed = result.history.filter(
        (e) =>
          e.attrs?.tool_call_id === tool_call_id &&
          e.attrs?.terminal === "failed" &&
          e.attrs?.replay !== true,
      );
      expect(failed.length).toBeGreaterThanOrEqual(1);
      expect(failed[0]?.attrs?.field_provenance).toMatchObject({ terminal: "target" });
      expect(failed[0]?.attrs?.runtime_generation).toBe(2);

      const receipts = result.history.filter((e) => e.op === "effect.receipt");
      expect(receipts.at(-1)?.attrs?.outcome).toBe("unknown");
      expect(receipts.at(-1)?.attrs?.reason).toBe("file_absent");

      const events = parse_history_jsonl(result.history_jsonl);
      expect(auth(events, "AUTH-02").observed_result).toBe("inconclusive");
      const a07 = auth(events, "AUTH-07");
      expect(a07.observed_result).toBe("supported");
      expect(target_witness_seqs(events, a07).length).toBeGreaterThanOrEqual(1);
    },
    60_000,
  );

  it(
    "ASA_FAKE_WRITE_WITHOUT_PERMISSION=1: defect write lands; AUTH-02 committed_without_grant; AUTH-07 restart-vs-complete race (checker bug, documented)",
    async () => {
      const cwd = tmp_dir("write-wo-perm");
      const result = await collect_history(
        mid_write_opts(cwd, { ASA_FAKE_WRITE_WITHOUT_PERMISSION: "1" }),
      );
      expect(result.run_valid).toBe(true);
      expect(result.events.filter((e) => e.type === "permission_response")).toHaveLength(0);

      const files = fs.readdirSync(cwd).filter((f) => f.startsWith("asa-mid-write-"));
      expect(files.length).toBe(1);

      const receipts = result.history.filter((e) => e.op === "effect.receipt");
      const committed = receipts.filter((e) => e.attrs?.outcome === "committed");
      expect(committed.length).toBeGreaterThanOrEqual(1);

      const events = parse_history_jsonl(result.history_jsonl);
      const a02 = auth(events, "AUTH-02");
      expect(a02.observed_result).toBe("violation");
      expect(a02.explanation).toMatch(/committed_without_grant/);

      const a07 = auth(events, "AUTH-07");
      // Disk check after restart + unfinished bind → Ambiguous terminal race (restart vs complete).
      // Agent never reported completed; effect.receipt committed still counts as complete for AUTH-07.
      expect(a07.observed_result).toBe("violation");
      expect(a07.explanation).toMatch(/Ambiguous terminal race \(restart vs complete\)/);
    },
    60_000,
  );
});
