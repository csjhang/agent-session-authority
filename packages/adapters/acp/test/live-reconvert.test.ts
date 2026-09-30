/**
 * Offline tests for live_history_from_peer_events + live_reconvert.
 * All check/write cases use tmpdir copies of history+run+peer-events (never touch repo live-runs).
 * Never spawns real claude-agent-acp or calls the Anthropic API.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  collect_history,
  live_history_from_peer_events,
  history_to_jsonl,
  check_live_run,
  check_live_runs,
  write_live_runs,
} from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fake_agent = path.join(here, "fixtures", "fake-acp-agent.mjs");
const repo_live = path.resolve(here, "../../../../targets/claude-agent-acp/results/live-runs");
const SAMPLE = path.join(repo_live, "effect", "r1");

function tmp_dir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `asa-pr8a-${label}-`));
}

function copy_run(src: string, dest_root: string, scenario = "effect", run_id = "r1"): string {
  const dest = path.join(dest_root, scenario, run_id);
  fs.mkdirSync(dest, { recursive: true });
  for (const name of ["history.jsonl", "run.json", "peer-events.jsonl"]) {
    fs.copyFileSync(path.join(src, name), path.join(dest, name));
  }
  return dest;
}

describe("live_reconvert", () => {
  it("1. check_live_run: tmpdir copy of effect/r1 is OK under live_history_from_peer_events", () => {
    const root = tmp_dir("ok");
    const run_dir = copy_run(SAMPLE, root);
    const peer = fs
      .readFileSync(path.join(run_dir, "peer-events.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    const recon = history_to_jsonl(live_history_from_peer_events(peer));
    expect(recon).toBe(fs.readFileSync(path.join(run_dir, "history.jsonl"), "utf8"));
    const check = check_live_run(run_dir, "effect/r1");
    expect(check).toEqual({ key: "effect/r1", ok: true });
  });

  it("2. check_live_run: corrupted history.jsonl → PROBLEM mismatch", () => {
    const root = tmp_dir("mismatch");
    const run_dir = copy_run(SAMPLE, root);
    fs.writeFileSync(path.join(run_dir, "history.jsonl"), "{}\n");
    const check = check_live_run(run_dir, "effect/r1");
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.problem).toBe("history.jsonl does not match reconversion from peer-events.jsonl");
    }
  });

  it("3. check_live_run: missing peer-events.jsonl → PROBLEM", () => {
    const root = tmp_dir("no-peer");
    const run_dir = copy_run(SAMPLE, root);
    fs.unlinkSync(path.join(run_dir, "peer-events.jsonl"));
    const check = check_live_run(run_dir, "effect/r1");
    expect(check).toEqual({ key: "effect/r1", ok: false, problem: "missing peer-events.jsonl" });
  });

  it("4. check_live_run: missing history.jsonl → PROBLEM", () => {
    const root = tmp_dir("no-hist");
    const run_dir = copy_run(SAMPLE, root);
    fs.unlinkSync(path.join(run_dir, "history.jsonl"));
    const check = check_live_run(run_dir, "effect/r1");
    expect(check).toEqual({ key: "effect/r1", ok: false, problem: "missing history.jsonl" });
  });

  it("5. write_live_runs: REWROTE then UNCHANGED; peer-events untouched; secret leak SKIPPED", () => {
    const root = tmp_dir("write");
    const run_dir = copy_run(SAMPLE, root, "effect", "r1");
    const peer_before = fs.readFileSync(path.join(run_dir, "peer-events.jsonl"));
    fs.writeFileSync(path.join(run_dir, "history.jsonl"), "corrupt\n");

    const first = write_live_runs(root, process.env);
    expect(first).toEqual([{ key: "effect/r1", status: "REWROTE" }]);
    expect(fs.readFileSync(path.join(run_dir, "peer-events.jsonl"))).toEqual(peer_before);
    const check = check_live_run(run_dir, "effect/r1");
    expect(check.ok).toBe(true);

    const second = write_live_runs(root, process.env);
    expect(second).toEqual([{ key: "effect/r1", status: "UNCHANGED" }]);

    // Secret leak: inject key into peer-events so reconverted history would contain it,
    // then corrupt history so write path is taken — should SKIPPED and leave corrupt history.
    const leak_root = tmp_dir("leak");
    const leak_dir = copy_run(SAMPLE, leak_root, "effect", "r1");
    const key = "sk-ant-leaktest0123456789abcdef";
    const peer_lines = fs
      .readFileSync(path.join(leak_dir, "peer-events.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim());
    // Append a harmless-looking session_update that embeds the key in text so reconversion
    // may or may not include it; instead force secret_leak_reason by writing a history that
    // already would match after we patch live path — simpler: stub env and put key in
    // reconverted content by appending a peer event with the key in an agent_message_chunk.
    peer_lines.push(
      JSON.stringify({
        type: "session_update",
        sessionId: "leak",
        observed_at_ms: 1,
        update: { kind: "agent_message_chunk", text: `secret ${key}` },
      }),
    );
    fs.writeFileSync(path.join(leak_dir, "peer-events.jsonl"), peer_lines.join("\n") + "\n");
    fs.writeFileSync(path.join(leak_dir, "history.jsonl"), "stale\n");
    const leak_results = write_live_runs(leak_root, { ...process.env, ANTHROPIC_API_KEY: key });
    expect(leak_results).toHaveLength(1);
    expect(leak_results[0]!.status).toBe("SKIPPED");
    if (leak_results[0]!.status === "SKIPPED") {
      expect(leak_results[0]!.problem).toMatch(/refusing to write history\.jsonl/);
    }
    expect(fs.readFileSync(path.join(leak_dir, "history.jsonl"), "utf8")).toBe("stale\n");
  });

  it(
    "6. fake agent live collect_history history matches live_history_from_peer_events(events)",
    async () => {
      const cwd = tmp_dir("fake");
      const result = await collect_history({
        mode: "live",
        scenario: "effect",
        cwd,
        live_command: process.execPath,
        live_args: [fake_agent],
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: "offline-fake-agent-placeholder",
        },
        effect_grace_ms: 3000,
        always_grant_poll_ms: 3000,
        live_observe_ms: 5000,
      });
      const from_helper = live_history_from_peer_events(result.events);
      expect(history_to_jsonl(result.history)).toBe(history_to_jsonl(from_helper));

      const out_root = tmp_dir("fake-out");
      const run_dir = path.join(out_root, "effect", "fake1");
      fs.mkdirSync(run_dir, { recursive: true });
      fs.writeFileSync(path.join(run_dir, "peer-events.jsonl"), result.events.map((e) => JSON.stringify(e)).join("\n") + "\n");
      fs.writeFileSync(path.join(run_dir, "history.jsonl"), result.history_jsonl);
      fs.writeFileSync(
        path.join(run_dir, "run.json"),
        JSON.stringify({ mode: "live", scenario: "effect", run_id: "fake1", run_valid: true }) + "\n",
      );
      expect(check_live_runs(out_root)).toEqual([{ key: "effect/fake1", ok: true }]);
    },
    60000,
  );
});
