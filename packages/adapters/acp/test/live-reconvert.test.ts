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
  check_live_runs,
  write_live_runs,
} from "../src/index.js";
import { write_live_run } from "../src/live_output.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fake_agent = path.join(here, "fixtures", "fake-acp-agent.mjs");
const REPO_LIVE_RUNS = path.resolve(here, "../../../../targets/claude-agent-acp/results/live-runs");

function tmp_dir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `asa-pr8a-${label}-`));
}

function copy_run(src: string, dest_root: string, scenario: string, run_id: string): string {
  const dest = path.join(dest_root, scenario, run_id);
  fs.mkdirSync(dest, { recursive: true });
  for (const name of ["history.jsonl", "run.json", "peer-events.jsonl"]) {
    fs.copyFileSync(path.join(src, name), path.join(dest, name));
  }
  return dest;
}

describe("live_reconvert", () => {
  it("1. check_live_runs(REPO_LIVE_RUNS) length >= 13; every problems []", () => {
    const results = check_live_runs(REPO_LIVE_RUNS);
    expect(results.length).toBeGreaterThanOrEqual(13);
    for (const r of results) {
      expect(r.problems).toEqual([]);
    }
  });

  it("2. history line-3 observe tweak → first differing line 3", () => {
    const root = tmp_dir("line3");
    const src = path.join(REPO_LIVE_RUNS, "effect", "r1");
    const run_dir = copy_run(src, root, "effect", "r1");
    const hist_path = path.join(run_dir, "history.jsonl");
    const lines = fs.readFileSync(hist_path, "utf8").split("\n");
    // Line 3 (1-based) — replace first "kind":"observe" on that line with spaced variant.
    lines[2] = lines[2]!.replace('"kind":"observe"', '"kind":"observe "');
    fs.writeFileSync(hist_path, lines.join("\n"));
    const results = check_live_runs(root);
    expect(results).toHaveLength(1);
    expect(results[0]!.problems).toEqual([
      "history.jsonl differs from reconversion of peer-events.jsonl (first differing line 3)",
    ]);
  });

  it("3. run.json events=1 history_events=2 → both count mismatch problems", () => {
    const root = tmp_dir("counts");
    const src = path.join(REPO_LIVE_RUNS, "stale-effect", "r2");
    const run_dir = copy_run(src, root, "stale-effect", "r2");
    const peer_m = fs
      .readFileSync(path.join(run_dir, "peer-events.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim()).length;
    const hist_m = fs
      .readFileSync(path.join(run_dir, "history.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim()).length;
    const run_path = path.join(run_dir, "run.json");
    const obj = JSON.parse(fs.readFileSync(run_path, "utf8")) as Record<string, unknown>;
    obj.events = 1;
    obj.history_events = 2;
    fs.writeFileSync(run_path, JSON.stringify(obj, null, 2) + "\n");
    const results = check_live_runs(root);
    expect(results).toHaveLength(1);
    const problems = results[0]!.problems;
    expect(problems).toContain(`run.json events=1 != peer-events.jsonl lines ${peer_m}`);
    expect(problems).toContain(`run.json history_events=2 != history.jsonl lines ${hist_m}`);
  });

  it("4. missing peer-events → skip write; history unchanged", () => {
    const root = tmp_dir("no-peer");
    const src = path.join(REPO_LIVE_RUNS, "reject-always", "r1");
    const run_dir = copy_run(src, root, "reject-always", "r1");
    fs.unlinkSync(path.join(run_dir, "peer-events.jsonl"));
    const hist_before = fs.readFileSync(path.join(run_dir, "history.jsonl"));
    const results = check_live_runs(root);
    expect(results).toHaveLength(1);
    expect(results[0]!.problems).toContain("peer-events.jsonl missing");
    const written = write_live_runs(root, process.env);
    expect(written.skipped.map((s) => s.run)).toEqual(["reject-always/r1"]);
    expect(written.rewritten).toEqual([]);
    expect(fs.readFileSync(path.join(run_dir, "history.jsonl"))).toEqual(hist_before);
  });

  it("5. truncated history → rewrite restores repo bytes; second write unchanged", () => {
    const root = tmp_dir("truncate");
    const src = path.join(REPO_LIVE_RUNS, "always-grant", "r2");
    const run_dir = copy_run(src, root, "always-grant", "r2");
    const peer_before = fs.readFileSync(path.join(run_dir, "peer-events.jsonl"));
    const repo_hist = fs.readFileSync(path.join(src, "history.jsonl"));
    const repo_run = fs.readFileSync(path.join(src, "run.json"));

    const hist_lines = fs
      .readFileSync(path.join(run_dir, "history.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim());
    fs.writeFileSync(path.join(run_dir, "history.jsonl"), hist_lines.slice(0, 5).join("\n") + "\n");
    const run_path = path.join(run_dir, "run.json");
    const obj = JSON.parse(fs.readFileSync(run_path, "utf8")) as Record<string, unknown>;
    obj.history_events = 5;
    fs.writeFileSync(run_path, JSON.stringify(obj, null, 2) + "\n");

    const first = write_live_runs(root, process.env);
    expect(first).toEqual({
      rewritten: ["always-grant/r2"],
      unchanged: [],
      skipped: [],
    });
    expect(fs.readFileSync(path.join(run_dir, "history.jsonl"))).toEqual(repo_hist);
    expect(fs.readFileSync(path.join(run_dir, "run.json"))).toEqual(repo_run);
    expect(fs.readFileSync(path.join(run_dir, "peer-events.jsonl"))).toEqual(peer_before);

    const second = write_live_runs(root, process.env);
    expect(second).toEqual({
      rewritten: [],
      unchanged: ["always-grant/r2"],
      skipped: [],
    });
  });

  it(
    "6. fake agent collect_history effect + write_live_run → check_live_runs effect/fake1 problems []",
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
      const out_root = tmp_dir("fake-out");
      write_live_run(result, {
        out_root,
        scenario: "effect",
        run_id: "fake1",
        env: process.env,
      });
      const results = check_live_runs(out_root);
      expect(results).toHaveLength(1);
      expect(results[0]!.run).toBe("effect/fake1");
      expect(results[0]!.problems).toEqual([]);
    },
    60000,
  );
});
