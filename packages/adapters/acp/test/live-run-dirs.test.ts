/**
 * PR-10c B: shared live-runs walk (list_live_run_dirs) used by live_reconvert and
 * scripts/live-vector. Only real directories are walked at the scenario/run layers;
 * a symlink (even to a directory) or a plain file there is reported, never followed
 * and never silently skipped:
 *   live-vector  → excluded with reason
 *   reconvert    → PROBLEM (check) / SKIPPED (write) → non-zero exit
 * Offline; tmpdir copies only (never touches repo live-runs).
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { check_live_runs, write_live_runs } from "../src/index.js";
import { list_live_run_dirs } from "../src/live_run_dirs.js";
import { ACP_LIVE } from "../../../../scripts/generate-capability-vectors.js";
import { load_live_runs } from "../../../../scripts/live-vector.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../../../..");
const REPO_LIVE_RUNS = path.join(REPO_ROOT, "targets/claude-agent-acp/results/live-runs");
const NOT_REAL_DIR = /not a real directory/;

function tmp_dir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `asa-pr10c-${label}-`));
}

function copy_run(dest_root: string, scenario: string, run_id: string): string {
  const src = path.join(REPO_LIVE_RUNS, "effect", "r1");
  const dest = path.join(dest_root, scenario, run_id);
  fs.mkdirSync(dest, { recursive: true });
  for (const name of ["history.jsonl", "run.json", "peer-events.jsonl"]) {
    fs.copyFileSync(path.join(src, name), path.join(dest, name));
  }
  return dest;
}

/** Directory symlink ("junction" on Windows needs no privilege; ignored elsewhere). */
function try_dir_symlink(target: string, link: string): boolean {
  try {
    fs.symlinkSync(target, link, "junction");
    return true;
  } catch {
    return false;
  }
}

const can_symlink = (() => {
  const d = tmp_dir("probe");
  fs.mkdirSync(path.join(d, "t"));
  return try_dir_symlink(path.join(d, "t"), path.join(d, "l"));
})();

function reconvert_cli(root: string, write = false) {
  return spawnSync(
    process.execPath,
    [
      path.join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs"),
      path.join(REPO_ROOT, "scripts/reconvert-live-runs.ts"),
      "--runs-root",
      root,
      ...(write ? ["--write"] : []),
    ],
    { encoding: "utf8" },
  );
}

describe("list_live_run_dirs (shared live-runs walk)", () => {
  it("repo live-runs: same scenario/run set as a real-directory walk; nothing rejected", () => {
    const entries = list_live_run_dirs(REPO_LIVE_RUNS);
    expect(entries.filter((e) => e.kind === "rejected")).toEqual([]);
    const expected: string[] = [];
    for (const s of fs.readdirSync(REPO_LIVE_RUNS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
      for (const r of fs.readdirSync(path.join(REPO_LIVE_RUNS, s), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
        expected.push(`${s}/${r}`);
      }
    }
    expect(entries.map((e) => e.run)).toEqual(expected);
    expect(expected.length).toBeGreaterThanOrEqual(13);
  });

  it("missing runs_root → no entries", () => {
    expect(list_live_run_dirs(path.join(tmp_dir("missing"), "nope"))).toEqual([]);
  });

  it("plain file at scenario and run layers: live-vector excluded with reason; reconvert PROBLEM + exit 1 (never skipped)", () => {
    const root = tmp_dir("files");
    copy_run(root, "effect", "r1");
    fs.writeFileSync(path.join(root, "README.md"), "not a scenario\n");
    fs.writeFileSync(path.join(root, "effect", "notes.txt"), "not a run\n");

    const entries = list_live_run_dirs(root);
    expect(entries.map((e) => `${e.kind}:${e.run}`)).toEqual([
      "rejected:README.md",
      "rejected:effect/notes.txt",
      "run:effect/r1",
    ]);
    for (const e of entries) {
      if (e.kind === "rejected") expect(e.reason).toMatch(/not a real directory \(plain file\)/);
    }
    const scen = entries.find((e) => e.run === "README.md");
    expect(scen && scen.kind === "rejected" && scen.layer).toBe("scenario");

    // live-vector: real run still included; both files listed as excluded with reason.
    const { included, excluded } = load_live_runs(root, REPO_ROOT, { ...ACP_LIVE, runs_dir: root }, "claude-agent-acp");
    expect(included.map((r) => `${r.scenario}/${r.run_id}`)).toEqual(["effect/r1"]);
    expect(excluded).toEqual([
      { scenario: "README.md", run_id: "*", reasons: [expect.stringMatching(NOT_REAL_DIR)] },
      { scenario: "effect", run_id: "notes.txt", reasons: [expect.stringMatching(NOT_REAL_DIR)] },
    ]);

    // reconvert check: problem rows for both; real run OK.
    const checks = check_live_runs(root);
    expect(checks.map((c) => [c.run, c.problems.length])).toEqual([
      ["README.md", 1],
      ["effect/notes.txt", 1],
      ["effect/r1", 0],
    ]);
    const r = reconvert_cli(root);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/PROBLEM README\.md: scenario entry is not a real directory \(plain file\)/);
    expect(r.stdout).toMatch(/PROBLEM effect\/notes\.txt: run entry is not a real directory \(plain file\)/);
    expect(r.stdout).toContain("1/3 live runs match their peer events");

    // --write: skipped (never writes), exit 1; files untouched.
    const w = write_live_runs(root, process.env);
    expect(w.unchanged).toEqual(["effect/r1"]);
    expect(w.rewritten).toEqual([]);
    expect(w.skipped.map((s) => s.run)).toEqual(["README.md", "effect/notes.txt"]);
    expect(reconvert_cli(root, true).status).toBe(1);
    expect(fs.readFileSync(path.join(root, "effect", "notes.txt"), "utf8")).toBe("not a run\n");
  }, 60_000);

  it.skipIf(!can_symlink)(
    "symlink → directory at scenario and run layers: not followed; live-vector excluded; reconvert PROBLEM + exit 1",
    () => {
      const root = tmp_dir("links");
      const real = copy_run(root, "effect", "r1");
      // Run-layer symlink to a valid run dir (would reconvert OK if followed).
      expect(try_dir_symlink(real, path.join(root, "effect", "r2-link"))).toBe(true);
      // Scenario-layer symlink to a valid scenario dir (outside root).
      const outside = tmp_dir("outside");
      copy_run(outside, "stale-grant", "r9");
      expect(try_dir_symlink(path.join(outside, "stale-grant"), path.join(root, "linked-scenario"))).toBe(true);

      const entries = list_live_run_dirs(root);
      expect(entries.map((e) => `${e.kind}:${e.run}`)).toEqual([
        "run:effect/r1",
        "rejected:effect/r2-link",
        "rejected:linked-scenario",
      ]);
      for (const e of entries) {
        if (e.kind === "rejected") expect(e.reason).toMatch(/not a real directory \(symlink to directory\)/);
      }

      const { included, excluded } = load_live_runs(root, REPO_ROOT, { ...ACP_LIVE, runs_dir: root }, "claude-agent-acp");
      expect(included.map((r) => `${r.scenario}/${r.run_id}`)).toEqual(["effect/r1"]);
      expect(excluded).toEqual([
        { scenario: "effect", run_id: "r2-link", reasons: [expect.stringMatching(/run entry is not a real directory \(symlink to directory\)/)] },
        { scenario: "linked-scenario", run_id: "*", reasons: [expect.stringMatching(/scenario entry is not a real directory \(symlink to directory\)/)] },
      ]);

      const r = reconvert_cli(root);
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(/PROBLEM effect\/r2-link: run entry is not a real directory/);
      expect(r.stdout).toMatch(/PROBLEM linked-scenario: scenario entry is not a real directory/);
      expect(r.stdout).not.toMatch(/OK linked-scenario\/r9/);
      expect(r.stdout).toContain("1/3 live runs match their peer events");

      const w = write_live_runs(root, process.env);
      expect(w.skipped.map((s) => s.run)).toEqual(["effect/r2-link", "linked-scenario"]);
      expect(w.unchanged).toEqual(["effect/r1"]);
    },
    60_000,
  );
});
