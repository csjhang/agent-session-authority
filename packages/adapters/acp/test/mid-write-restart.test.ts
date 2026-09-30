/**
 * Offline mid-write-restart: SIGTERM while Write permission is outstanding (before allow).
 * Round 2: clear abandoned prompt timer; never-reached → run_valid=false; replay-terminal
 * outcome; target_witness via real live aggregation (write_live_run + ACP_LIVE).
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { parse_history_jsonl, run_checkers, default_assessment } from "@asa/core";
import type { HistoryEvent } from "@asa/core";
import { collect_history } from "../src/index.js";
import { write_live_run } from "../src/live_output.js";
import { ACP_LIVE } from "../../../../scripts/generate-capability-vectors.js";
import { load_live_runs, aggregate_live } from "../../../../scripts/live-vector.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo_root = path.resolve(here, "../../../..");
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

/** Write a fake mid-write run through write_live_run, then aggregate with real ACP_LIVE. */
function aggregate_mid_write(result: Awaited<ReturnType<typeof collect_history>>, run_id: string) {
  const root = tmp_dir("live-agg");
  write_live_run(result, {
    out_root: root,
    scenario: "mid-write-restart",
    run_id,
    env: fake_env(),
  });
  // Point ACP_LIVE at this temp root without mutating the shared export object permanently.
  const cfg = { ...ACP_LIVE, runs_dir: root };
  const { included, excluded } = load_live_runs(root, repo_root, cfg, "claude-agent-acp");
  const vector = aggregate_live(included, excluded, cfg);
  return { root, included, excluded, vector };
}

describe("mid-write-restart (permission outstanding before allow)", () => {
  it(
    "default/silent: interrupt before allow; gen2 load + disk only; AUTH-02 inconclusive; AUTH-07 checker supported; live aggregation downgrades AUTH-07 (no target_witness)",
    async () => {
      const cwd = tmp_dir("silent");
      const result = await collect_history(mid_write_opts(cwd));
      expect(result.run_valid).toBe(true);
      expect(result.notes.some((n) => /cleared \d+ pending client request timer/.test(n))).toBe(true);

      const reqs = result.events.filter((e) => e.type === "permission_request");
      const resps = result.events.filter((e) => e.type === "permission_response");
      expect(reqs.length).toBe(1);
      expect(resps.length).toBe(0);

      expect(result.history.some((e) => e.fault === "runtime.restart")).toBe(true);
      expect(
        result.events.some((e) => e.type === "session_update" && e.update.kind === "session_load"),
      ).toBe(true);

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

      // Real live aggregation path (write_live_run + ACP_LIVE target_witness), not test-local rewrite.
      const { included, vector } = aggregate_mid_write(result, "silent1");
      expect(included).toHaveLength(1);
      expect(included[0]!.observed["AUTH-07"]).toBe("inconclusive");
      expect(included[0]!.downgraded?.["AUTH-07"]).toMatch(/no claude-agent-acp tool-call status among the witnesses/);
      expect(vector.observed_vector["AUTH-07"]).toBe("inconclusive");

      expect(result.notes.some((n) => /mid-write-restart/i.test(n) && /outstanding/i.test(n))).toBe(
        true,
      );
    },
    60_000,
  );

  it(
    "ASA_FAKE_REPORT_FAILED_ON_LOAD=1: post-load failed; live aggregation keeps AUTH-07 supported (target_witness present)",
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

      const { included, vector } = aggregate_mid_write(result, "failed1");
      expect(included).toHaveLength(1);
      expect(included[0]!.observed["AUTH-07"]).toBe("supported");
      expect(included[0]!.downgraded?.["AUTH-07"]).toBeUndefined();
      expect(vector.observed_vector["AUTH-07"]).toBe("supported");
    },
    60_000,
  );

  it(
    "ASA_FAKE_WRITE_WITHOUT_PERMISSION=1: defect write lands; AUTH-02 committed_without_grant; AUTH-07 restart-vs-complete race (documented)",
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
      expect(a07.observed_result).toBe("violation");
      expect(a07.explanation).toMatch(/Ambiguous terminal race \(restart vs complete\)/);
    },
    60_000,
  );

  it(
    "after mid-write-restart, subprocess exits promptly (no leftover 180s session/prompt timer)",
    () => {
      // Windows CI (fail-first): bare absolute path in `import … from "D:\…"` makes Node's
      // ESM loader throw ERR_UNSUPPORTED_ESM_URL_SCHEME (Received protocol 'd:'). tsx register
      // requires a file:// URL — same pathToFileURL pattern as adapter/sink dynamic imports.
      const collect_history_href = pathToFileURL(
        path.join(repo_root, "packages/adapters/acp/src/index.ts"),
      ).href;
      const script = `
        import { collect_history } from ${JSON.stringify(collect_history_href)};
        import fs from "node:fs";
        import os from "node:os";
        import path from "node:path";
        const fake = ${JSON.stringify(fake_agent)};
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "asa-pr9a-exit-"));
        const t0 = Date.now();
        const result = await collect_history({
          mode: "live",
          scenario: "mid-write-restart",
          cwd,
          live_command: process.execPath,
          live_args: [fake],
          env: { ...process.env, ANTHROPIC_API_KEY: "offline-fake-agent-placeholder" },
          effect_grace_ms: 1500,
          always_grant_poll_ms: 1500,
          live_observe_ms: 5000,
        });
        const ms = Date.now() - t0;
        if (!result.run_valid) { console.error("run_valid=false", result.invalid_reasons); process.exit(2); }
        if (!result.notes.some((n) => /cleared \\d+ pending client request timer/.test(n))) {
          console.error("missing cancel note", result.notes.slice(-5));
          process.exit(3);
        }
        console.log("ok collect_ms=" + ms);
        process.exit(0);
      `;
      const start = Date.now();
      const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        cwd: repo_root,
        encoding: "utf8",
        timeout: 25_000,
        env: process.env,
      });
      const wall = Date.now() - start;
      expect(r.error, `spawn error: ${String(r.error)} stdout=${r.stdout} stderr=${r.stderr}`).toBeUndefined();
      expect(r.status, `status=${r.status} stdout=${r.stdout} stderr=${r.stderr}`).toBe(0);
      // Without the cancel_pending fix this hangs ~180s until the abandoned prompt timer fires.
      expect(wall, `wall_ms=${wall} stdout=${r.stdout}`).toBeLessThan(20_000);
      expect(r.stdout).toMatch(/ok collect_ms=/);
    },
    30_000,
  );

  it(
    "ASA_FAKE_NO_TOOLS=1: never reaches interrupt → run_valid=false with clear reason; dir kept",
    async () => {
      const cwd = tmp_dir("no-tools");
      const result = await collect_history(mid_write_opts(cwd, { ASA_FAKE_NO_TOOLS: "1" }));
      expect(result.run_valid).toBe(false);
      expect(result.invalid_reasons.some((r) => /never reached interrupt point/.test(r))).toBe(true);
      expect(result.notes.some((n) => /RUN INVALID:.*never reached interrupt point/.test(n))).toBe(true);
      expect(result.events.filter((e) => e.type === "permission_request")).toHaveLength(0);
      // Directory kept (cwd still exists) — mirror version-mismatch pattern.
      expect(fs.existsSync(cwd)).toBe(true);

      // Excluded from live aggregation when written.
      const { included, excluded } = aggregate_mid_write(result, "no-tools1");
      expect(included).toHaveLength(0);
      expect(excluded.some((e) => e.run_id === "no-tools1" && e.reasons.some((r) => /run_valid is not true/.test(r)))).toBe(
        true,
      );
    },
    60_000,
  );

  it(
    "ASA_FAKE_REPLAY_TERMINAL_ON_LOAD=1: first terminal only in session/load replay → marked replay; live aggregation downgrades AUTH-07",
    async () => {
      const cwd = tmp_dir("replay-term");
      const result = await collect_history(
        mid_write_opts(cwd, { ASA_FAKE_REPLAY_TERMINAL_ON_LOAD: "1" }),
      );
      expect(result.run_valid).toBe(true);

      const req = result.events.find((e) => e.type === "permission_request");
      const tool_call_id =
        req && req.type === "permission_request" ? req.toolCallId : undefined;
      expect(tool_call_id).toBeTruthy();

      // History judgment: replay-period updates carry replay:true and no terminal.
      const replayed = result.history.filter(
        (e) => e.attrs?.tool_call_id === tool_call_id && e.attrs?.replay === true,
      );
      expect(replayed.length).toBeGreaterThanOrEqual(1);
      expect(replayed.every((e) => e.attrs?.terminal === undefined)).toBe(true);

      // No non-replay agent terminal for the interrupted call.
      const agent_terminal = result.history.filter(
        (e) =>
          e.attrs?.tool_call_id === tool_call_id &&
          e.attrs?.terminal !== undefined &&
          e.attrs?.replay !== true,
      );
      expect(agent_terminal).toHaveLength(0);

      // Notes must not count replay-period updates as post-load agent reports.
      // Initial tool_call carries ACP category kind:"edit" on the observed event; notes must
      // still count it (same cut as history: raw_update.sessionUpdate === "tool_call").
      // REPLAY_TERMINAL_ON_LOAD emits tool_call (edit) + tool_call_update (failed) → 2.
      expect(result.notes.some((n) => /replay-period tool_call updates=2\b/.test(n))).toBe(true);
      expect(replayed.length).toBe(2);
      expect(result.notes.some((n) => /post-load tool_call reports=0/.test(n))).toBe(true);

      const events = parse_history_jsonl(result.history_jsonl);
      // Checker alone may still say supported (probe receipt + restart); safeguards downgrade.
      expect(auth(events, "AUTH-07").observed_result).toBe("supported");

      const { included, vector } = aggregate_mid_write(result, "replay1");
      expect(included).toHaveLength(1);
      expect(included[0]!.observed["AUTH-07"]).toBe("inconclusive");
      expect(included[0]!.downgraded?.["AUTH-07"]).toMatch(/no claude-agent-acp tool-call status among the witnesses/);
      expect(vector.observed_vector["AUTH-07"]).toBe("inconclusive");
    },
    60_000,
  );
});
