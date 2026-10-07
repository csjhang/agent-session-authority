/**
 * PR-10c D: the mid-write post-load wait and the always-grant / reject-always gen2
 * tool-event count use is_tool_call_session_update (raw_update.sessionUpdate), the same
 * cut as the mid-write notes and history. An initial tool_call carries ACP category
 * kind "edit" on the observed update, which the old update.kind check missed.
 * Offline fake agent only.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collect_history } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fake_agent = path.join(here, "fixtures", "fake-acp-agent.mjs");

function tmp_dir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `asa-pr10c-d-${label}-`));
}

function opts(scenario: "mid-write-restart" | "always-grant" | "reject-always", cwd: string, extra: Record<string, string>, effect_grace_ms = 1500) {
  return {
    mode: "live" as const,
    scenario,
    cwd,
    live_command: process.execPath,
    live_args: [fake_agent],
    env: { ...process.env, ANTHROPIC_API_KEY: "offline-fake-agent-placeholder", ...extra },
    effect_grace_ms,
    always_grant_poll_ms: 1500,
    live_observe_ms: 5000,
  };
}

describe("tool-call cut (is_tool_call_session_update) for waits and counts", () => {
  for (const scenario of ["always-grant", "reject-always"] as const) {
    it(
      `${scenario} gen2: prompt error after a kind="edit" tool_call counts as a tool event → no follow-up Write prompt`,
      async () => {
        const result = await collect_history(
          opts(scenario, tmp_dir(scenario), { ASA_FAKE_TOOL_CALL_THEN_PROMPT_ERROR: "1", ASA_FAKE_OPTIONS: "with_reject_always" }),
        );
        // Peer update.kind is sessionUpdate ("tool_call"); ACP tool category "edit" stays on raw_update.kind.
        const gen2_start = result.events.findIndex((e) => e.type === "runtime_restart");
        const gen2_tool_calls = result.events
          .slice(gen2_start)
          .filter((e) => e.type === "session_update" && (e.update.raw_update as Record<string, unknown> | undefined)?.sessionUpdate === "tool_call");
        expect(gen2_tool_calls.length).toBeGreaterThanOrEqual(1);
        expect(gen2_tool_calls[0]!.type === "session_update" && gen2_tool_calls[0]!.update.kind).toBe("tool_call");
        const raw = gen2_tool_calls[0]!.type === "session_update"
          ? (gen2_tool_calls[0]!.update.raw_update as Record<string, unknown> | undefined)
          : undefined;
        expect(raw?.kind).toBe("edit");
        // Old cut counted 0 tool events and issued a follow-up prompt.
        expect(result.notes.some((n) => /issuing short follow-up Write prompt/.test(n))).toBe(false);
        expect(
          result.events.some(
            (e) => e.type === "session_update" && e.update.kind === "prompt_result" && String(e.update.prompt ?? "").endsWith("_followup"),
          ),
        ).toBe(false);
      },
      60_000,
    );
  }

  it(
    "mid-write post-load wait ends on a post-load tool_call (kind edit, status failed) instead of running out the grace",
    async () => {
      // effect_grace_ms 20000 → post-load grace 2000ms, interrupted-file disk probe 1500ms.
      const result = await collect_history(
        opts(
          "mid-write-restart",
          tmp_dir("postload"),
          { ASA_FAKE_REPORT_FAILED_ON_LOAD: "1", ASA_FAKE_POST_LOAD_AS_TOOL_CALL: "1" },
          20_000,
        ),
      );
      expect(result.run_valid).toBe(true);
      expect(result.notes.some((n) => /post-load tool_call reports=1 statuses=failed/.test(n))).toBe(true);
      const load = result.events.find((e) => e.type === "session_update" && e.update.kind === "session_load");
      const probe = result.events.find(
        (e) => e.type === "session_update" && e.update.kind === "effect_receipt" && e.update.sink === "wait_for_write_effect",
      );
      expect(load?.observed_at_ms).toBeTypeOf("number");
      expect(probe?.observed_at_ms).toBeTypeOf("number");
      // Disk probe (1500ms, file absent) ends ≈1.5s after load when the wait breaks early;
      // with the old cut the 2000ms post-load grace ran out first (≥3.5s).
      const gap = probe!.observed_at_ms! - load!.observed_at_ms!;
      expect(gap).toBeGreaterThanOrEqual(1400);
      expect(gap).toBeLessThan(3200);
    },
    60_000,
  );
});
