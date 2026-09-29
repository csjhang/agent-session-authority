import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run_cli } from "../src/cli.js";
import { build_report } from "../src/report.js";
import { run_checkers } from "../src/index.js";
import { load_history_file } from "../src/history.js";
import { load_profile } from "../src/declaration.js";
import { default_assessment, load_assessment } from "../src/assessment.js";

const repo_root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function capture_run(argv: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const code = run_cli(argv, {
    cwd,
    stdout: (s) => {
      stdout += s;
    },
    stderr: (s) => {
      stderr += s;
    },
  });
  return { code, stdout, stderr };
}

describe("run_cli exit codes and path resolution", () => {
  it("bad profile path → exit 2", () => {
    const { code, stderr } = capture_run(
      ["node", "asa", "check", path.join(repo_root, "corpus/auth02/pass.jsonl"), "--profile", "/no/such/profile.json"],
      repo_root,
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/\/no\/such\/profile\.json|no[/\\]such[/\\]profile\.json/);
  });

  it("--profile without value → exit 2", () => {
    const { code, stderr } = capture_run(
      ["node", "asa", "check", path.join(repo_root, "corpus/auth02/pass.jsonl"), "--profile"],
      repo_root,
    );
    expect(code).toBe(2);
    expect(stderr.length).toBeGreaterThan(0);
  });

  it("bad assessment path → exit 2", () => {
    const { code, stderr } = capture_run(
      [
        "node",
        "asa",
        "check",
        path.join(repo_root, "corpus/auth02/pass.jsonl"),
        "--assessment",
        "/no/such/assessment.json",
      ],
      repo_root,
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/assessment/);
  });

  it("missing history → exit 2", () => {
    const { code, stderr } = capture_run(
      ["node", "asa", "check", "/no/such/history.jsonl", "--profile", path.join(repo_root, "corpus/auth02/profile.json")],
      repo_root,
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/\/no\/such\/history\.jsonl|no[/\\]such[/\\]history\.jsonl/);
  });

  it("bad profile JSON → exit 2", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asa-cli-"));
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, "{not json", "utf8");
    const { code, stderr } = capture_run(
      ["node", "asa", "check", path.join(repo_root, "corpus/auth02/pass.jsonl"), "--profile", bad],
      repo_root,
    );
    expect(code).toBe(2);
    expect(stderr).toContain(bad);
  });

  it("claimed_invariants string → exit 2, stderr has /claimed_invariants", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asa-cli-"));
    const bad = path.join(dir, "profile.json");
    fs.writeFileSync(
      bad,
      JSON.stringify({ profile_version: "0.2", claimed_invariants: "AUTH-02" }),
      "utf8",
    );
    const { code, stderr } = capture_run(
      ["node", "asa", "check", path.join(repo_root, "corpus/auth02/pass.jsonl"), "--profile", bad],
      repo_root,
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/\/claimed_invariants/);
  });

  it('assessment test_basis "live" → exit 2, stderr has /test_basis', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asa-cli-"));
    const bad = path.join(dir, "assessment.json");
    fs.writeFileSync(bad, JSON.stringify({ test_basis: "live" }), "utf8");
    const { code, stderr } = capture_run(
      [
        "node",
        "asa",
        "check",
        path.join(repo_root, "corpus/auth02/pass.jsonl"),
        "--assessment",
        bad,
        "--profile",
        path.join(repo_root, "corpus/auth02/profile.json"),
      ],
      repo_root,
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/\/test_basis/);
  });

  it("unknown flag → exit 2", () => {
    const { code, stderr } = capture_run(
      ["node", "asa", "check", path.join(repo_root, "corpus/auth02/pass.jsonl"), "--bogus"],
      repo_root,
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/Unknown flag|--bogus/i);
  });

  it("no args → exit 2", () => {
    const { code } = capture_run(["node", "asa"], repo_root);
    expect(code).toBe(2);
  });

  it("cwd=packages/core, args corpus/auth02/pass.jsonl → exit 2 (no ../.. guess)", () => {
    const core_cwd = path.join(repo_root, "packages/core");
    const { code, stderr } = capture_run(
      ["node", "asa", "check", "corpus/auth02/pass.jsonl", "--profile", "corpus/auth02/profile.json"],
      core_cwd,
    );
    expect(code).toBe(2);
    expect(stderr.length).toBeGreaterThan(0);
  });

  it("corpus/auth02/pass.jsonl + profile → exit 0", () => {
    const { code } = capture_run(
      [
        "node",
        "asa",
        "check",
        "corpus/auth02/pass.jsonl",
        "--profile",
        "corpus/auth02/profile.json",
      ],
      repo_root,
    );
    expect(code).toBe(0);
  });

  it("violate.jsonl + profile → exit 1", () => {
    const { code } = capture_run(
      [
        "node",
        "asa",
        "check",
        "corpus/auth02/violate.jsonl",
        "--profile",
        "corpus/auth02/profile.json",
      ],
      repo_root,
    );
    expect(code).toBe(1);
  });

  it("research_profile, no profile, AUTH-06 counterexample history → exit 0 (rewritten not_declared)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asa-cli-"));
    const assessment_path = path.join(dir, "assessment.json");
    fs.writeFileSync(
      assessment_path,
      JSON.stringify({
        target: "research",
        profile_version: "0.2",
        test_basis: "research_profile",
      }),
      "utf8",
    );
    const { code, stdout } = capture_run(
      [
        "node",
        "asa",
        "check",
        path.join(repo_root, "corpus/auth06/violate.jsonl"),
        "--assessment",
        assessment_path,
      ],
      repo_root,
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/AUTH-06/);
  });

  it("--json: stdout JSON.parse equals build_report", () => {
    const history_path = path.join(repo_root, "corpus/auth02/pass.jsonl");
    const profile_path = path.join(repo_root, "corpus/auth02/profile.json");
    const { code, stdout, stderr } = capture_run(
      ["node", "asa", "check", history_path, "--profile", profile_path, "--json"],
      repo_root,
    );
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout);
    const events = load_history_file(history_path);
    const profile = load_profile(profile_path);
    const assessment = default_assessment();
    const findings = run_checkers(events, profile, assessment);
    const expected = build_report(findings, assessment, profile);
    expect(parsed).toEqual(expected);
  });
});
