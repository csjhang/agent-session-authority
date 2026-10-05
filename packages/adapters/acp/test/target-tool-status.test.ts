/**
 * Agent-reported tool-call status → AUTH-07 terminal events; session/load replay is marked, not counted.
 * Offline only: synthetic peer events, the committed live runs, and test/fixtures/fake-acp-agent.mjs.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse_history_jsonl, run_checkers } from "@asa/core";
import type { HistoryEvent } from "@asa/core";
import { acp_events_to_history, collect_history, live_history_from_peer_events } from "../src/index.js";
import type { AcpPeerEvent } from "../src/mock_peer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fake_agent = path.join(here, "fixtures", "fake-acp-agent.mjs");
const REPO_LIVE_RUNS = path.resolve(here, "../../../../targets/claude-agent-acp/results/live-runs");

const tool_update = (
  session_update: "tool_call" | "tool_call_update",
  tool_call_id: string,
  status: string | undefined,
  observed_at_ms: number,
): AcpPeerEvent => ({
  type: "session_update",
  sessionId: "s1",
  update: {
    kind: session_update === "tool_call" ? "edit" : "tool_call_update",
    toolCallId: tool_call_id,
    ...(status !== undefined ? { status } : {}),
    raw_update: { sessionUpdate: session_update, toolCallId: tool_call_id, ...(status !== undefined ? { status } : {}) },
  },
  observed_at_ms,
});

const auth07 = (history: unknown[]) =>
  run_checkers(history as HistoryEvent[], null, { test_basis: "research_profile" }).find((f) => f.invariant === "AUTH-07")!;

const fake_run = (scenario: "effect", extra: Record<string, string>) =>
  collect_history({
    mode: "live",
    scenario,
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), "asa-pr8c-")),
    live_command: process.execPath,
    live_args: [fake_agent],
    env: { ...process.env, ANTHROPIC_API_KEY: "offline-fake-agent-placeholder", ...extra },
    effect_grace_ms: 3000,
    always_grant_poll_ms: 3000,
    live_observe_ms: 5000,
  });

describe("agent-reported tool-call status", () => {
  it("1. completed/failed become terminal attrs with target provenance; pending, in_progress and missing status add nothing", () => {
    const history = acp_events_to_history(
      [
        tool_update("tool_call", "a", "pending", 1),
        tool_update("tool_call_update", "a", "in_progress", 2),
        tool_update("tool_call_update", "a", undefined, 3),
        tool_update("tool_call_update", "a", "completed", 4),
        tool_update("tool_call_update", "b", "failed", 5),
      ],
      { issuer_id: "acp_adapter_live" },
    );
    const updates = history.filter((e) => e.op === "session.attach" && e.attrs?.update_kind !== undefined);
    expect(updates.map((e) => e.attrs?.terminal)).toEqual([undefined, undefined, undefined, "completed", "failed"]);
    expect(updates[3]!.attrs).toMatchObject({
      tool_call_id: "a",
      terminal: "completed",
      runtime_generation: 1,
      field_provenance: { terminal: "target" },
    });
    expect(updates[4]!.attrs).toMatchObject({ tool_call_id: "b", terminal: "failed", runtime_generation: 1 });
  });

  it("2. updates replayed by session/load are marked replay and never counted as a second terminal", () => {
    const events: AcpPeerEvent[] = [
      tool_update("tool_call_update", "x", "completed", 1),
      { type: "runtime_restart", sessionId: "s1", reason: "SIGTERM_gen1_process_spawn", observed_at_ms: 2 },
      tool_update("tool_call", "x", "pending", 3),
      tool_update("tool_call_update", "x", "completed", 4),
      { type: "session_update", sessionId: "s1", update: { kind: "session_load", cwd: "/tmp/w" }, observed_at_ms: 5 },
      tool_update("tool_call_update", "y", "completed", 6),
    ];
    const history = live_history_from_peer_events(events);
    // One report per tool call and no receipt: nothing to compare. Counting the replay as a
    // second report would make x look examined and AUTH-07 falsely supported.
    expect(auth07(history).observed_result).toBe("inconclusive");
    const tool_events = history.filter((e) => e.attrs?.tool_call_id !== undefined);
    expect(tool_events.map((e) => [e.attrs?.tool_call_id, e.attrs?.terminal ?? null, e.attrs?.replay ?? false])).toEqual([
      ["x", "completed", false],
      ["x", null, true],
      ["x", null, true],
      ["y", "completed", false],
    ]);
    expect(tool_events[3]!.attrs?.runtime_generation).toBe(2);
  });

  it("3. permission-axis live runs: each tool call with a probe receipt has exactly one non-replay agent-reported terminal", () => {
    const scenarios = ["always-grant", "effect", "reject-always", "stale-effect", "stale-grant"];
    let runs = 0;
    for (const scenario of scenarios) {
      for (const run_id of fs.readdirSync(path.join(REPO_LIVE_RUNS, scenario)).sort()) {
        const events = parse_history_jsonl(fs.readFileSync(path.join(REPO_LIVE_RUNS, scenario, run_id, "history.jsonl"), "utf8"));
        const receipts = events.filter((e) => e.op === "effect.receipt").map((e) => String(e.attrs?.tool_call_id));
        expect(receipts.length, `${scenario}/${run_id}`).toBeGreaterThanOrEqual(2);
        for (const id of receipts) {
          const reports = events.filter((e) => e.attrs?.tool_call_id === id && e.attrs?.terminal !== undefined);
          expect(reports.length, `${scenario}/${run_id} ${id}`).toBe(1);
          expect(reports[0]!.attrs?.field_provenance).toMatchObject({ terminal: "target" });
        }
        expect(events.some((e) => e.attrs?.replay === true && e.attrs?.terminal !== undefined), `${scenario}/${run_id}`).toBe(false);
        runs++;
      }
    }
    expect(runs).toBeGreaterThanOrEqual(13);
  });

  it("3b. each valid mid-write-restart live run: one receipt, no grant/deny, restart before receipt, replay has no terminal", () => {
    const scenario = "mid-write-restart";
    const scenario_dir = path.join(REPO_LIVE_RUNS, scenario);
    expect(fs.existsSync(scenario_dir), "mid-write-restart live runs present").toBe(true);
    let valid = 0;
    for (const run_id of fs.readdirSync(scenario_dir).sort()) {
      const run_dir = path.join(scenario_dir, run_id);
      const manifest = JSON.parse(fs.readFileSync(path.join(run_dir, "run.json"), "utf8")) as { run_valid?: boolean };
      if (manifest.run_valid !== true) continue;
      const events = parse_history_jsonl(fs.readFileSync(path.join(run_dir, "history.jsonl"), "utf8"));
      const receipts = events.filter((e) => e.op === "effect.receipt");
      expect(receipts.length, `${scenario}/${run_id}`).toBe(1);
      const receipt = receipts[0]!;
      const tool_id = String(receipt.attrs?.tool_call_id);
      expect(
        events.some(
          (e) =>
            e.attrs?.tool_call_id === tool_id && (e.op === "approval.grant" || e.op === "approval.deny"),
        ),
        `${scenario}/${run_id} ${tool_id} has grant/deny`,
      ).toBe(false);
      const restart_idx = events.findIndex((e) => e.kind === "fault" && e.fault === "runtime.restart");
      const receipt_idx = events.indexOf(receipt);
      expect(restart_idx, `${scenario}/${run_id} runtime.restart`).toBeGreaterThanOrEqual(0);
      expect(restart_idx, `${scenario}/${run_id} restart before receipt`).toBeLessThan(receipt_idx);
      expect(
        events.some((e) => e.attrs?.replay === true && e.attrs?.terminal !== undefined),
        `${scenario}/${run_id} replay terminal`,
      ).toBe(false);
      const non_replay_terminals = events.filter(
        (e) => e.attrs?.tool_call_id === tool_id && e.attrs?.terminal !== undefined && e.attrs?.replay !== true,
      );
      expect(non_replay_terminals.length, `${scenario}/${run_id} non-replay terminals`).toBeLessThanOrEqual(1);
      if (non_replay_terminals.length === 1) {
        expect(non_replay_terminals[0]!.attrs?.field_provenance).toMatchObject({ terminal: "target" });
      }
      valid++;
    }
    expect(valid).toBeGreaterThanOrEqual(1);
  });

  it(
    "4. fake agent effect: reports match the disk in both generations → AUTH-07 supported",
    async () => {
      const r = await fake_run("effect", {});
      expect(r.history.filter((e) => e.attrs?.terminal === "completed")).toHaveLength(2);
      expect(auth07(r.history).observed_result).toBe("supported");
    },
    60_000,
  );

  it(
    "5. fake agent reports completed but never writes → AUTH-07 violation (unknown vs complete)",
    async () => {
      const r = await fake_run("effect", { ASA_FAKE_CLAIM_WITHOUT_WRITE: "1" });
      const f = auth07(r.history);
      expect(f.observed_result).toBe("violation");
      expect(f.explanation).toMatch(/Unknown terminal coexists with another terminal/);
    },
    60_000,
  );

  it(
    "6. fake agent writes but reports failed → AUTH-07 violation (failed vs complete)",
    async () => {
      const r = await fake_run("effect", { ASA_FAKE_FAIL_AFTER_WRITE: "1" });
      const f = auth07(r.history);
      expect(f.observed_result).toBe("violation");
      expect(f.explanation).toMatch(/Ambiguous terminal race \(failed vs complete\)/);
    },
    60_000,
  );

  it(
    "7. fake agent replays generation 1 on session/load → replayed updates marked, not counted; AUTH-07 supported",
    async () => {
      const r = await fake_run("effect", { ASA_FAKE_REPLAY_ON_LOAD: "1" });
      const replayed = r.history.filter((e) => e.attrs?.replay === true);
      expect(replayed.length).toBe(2);
      expect(replayed.every((e) => e.attrs?.terminal === undefined)).toBe(true);
      expect(r.history.filter((e) => e.attrs?.terminal === "completed")).toHaveLength(2);
      expect(auth07(r.history).observed_result).toBe("supported");
    },
    60_000,
  );
});
