/**
 * PR-10c E: the offline fake agent writes .asa-fake-transcript.json into the session cwd
 * only when a session/load mode reads it back (ASA_FAKE_REPLAY_ON_LOAD,
 * ASA_FAKE_REPORT_FAILED_ON_LOAD, ASA_FAKE_REPLAY_TERMINAL_ON_LOAD). Default-mode runs
 * must leave no transcript (fails on main, where every Write path wrote it).
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collect_history, type AdapterScenario } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fake_agent = path.join(here, "fixtures", "fake-acp-agent.mjs");
const TRANSCRIPT = ".asa-fake-transcript.json";

async function run(scenario: AdapterScenario, extra: Record<string, string> = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `asa-pr10c-e-${scenario}-`));
  const result = await collect_history({
    mode: "live",
    scenario,
    cwd,
    live_command: process.execPath,
    live_args: [fake_agent],
    env: { ...process.env, ANTHROPIC_API_KEY: "offline-fake-agent-placeholder", ...extra },
    effect_grace_ms: 1500,
    always_grant_poll_ms: 1500,
    live_observe_ms: 5000,
  });
  return { cwd, result };
}

describe("fake agent transcript only when needed", () => {
  for (const scenario of ["effect", "always-grant", "mid-write-restart"] as const) {
    it(`default mode ${scenario}: no ${TRANSCRIPT} in the session cwd`, async () => {
      const { cwd, result } = await run(scenario);
      expect(result.run_valid).toBe(true);
      // The Write tool path ran (so the old fake would have written the transcript).
      expect(result.events.some((e) => e.type === "permission_request")).toBe(true);
      expect(fs.existsSync(path.join(cwd, TRANSCRIPT))).toBe(false);
    }, 60_000);
  }

  it(`mid-write ASA_FAKE_WRITE_WITHOUT_PERMISSION: no ${TRANSCRIPT}`, async () => {
    const { cwd } = await run("mid-write-restart", { ASA_FAKE_WRITE_WITHOUT_PERMISSION: "1" });
    expect(fs.existsSync(path.join(cwd, TRANSCRIPT))).toBe(false);
  }, 60_000);

  for (const flag of ["ASA_FAKE_REPLAY_ON_LOAD", "ASA_FAKE_REPORT_FAILED_ON_LOAD", "ASA_FAKE_REPLAY_TERMINAL_ON_LOAD"]) {
    it(`mid-write ${flag}=1: transcript kept (pre-permission entry survives SIGTERM for gen2)`, async () => {
      const { cwd, result } = await run("mid-write-restart", { [flag]: "1" });
      expect(result.run_valid).toBe(true);
      const file = path.join(cwd, TRANSCRIPT);
      expect(fs.existsSync(file)).toBe(true);
      const calls = JSON.parse(fs.readFileSync(file, "utf8")) as Array<{ tool_call_id: string; status: string }>;
      const req = result.events.find((e) => e.type === "permission_request");
      expect(req && req.type === "permission_request" && calls.some((c) => c.tool_call_id === req.toolCallId)).toBe(true);
    }, 60_000);
  }
});
