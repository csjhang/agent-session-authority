import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { load_history_file } from "../src/history.js";
import { load_profile } from "../src/declaration.js";
import { default_assessment, type CheckFinding } from "../src/assessment.js";
import { run_checkers } from "../src/index.js";
import type { AuthorityProfile } from "../src/declaration.js";
import type { HistoryEvent } from "../src/history.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo_root = path.resolve(here, "../../..");

type Case = {
  file: string;
  events: HistoryEvent[];
  profile: AuthorityProfile | null;
  findings: CheckFinding[];
};

function isProfileOnly(f: CheckFinding, profile: AuthorityProfile | null): boolean {
  if (f.invariant === "AUTH-01a") return true;
  if (f.invariant === "AUTH-01c" && profile?.generation_model === "G0") return true;
  return false;
}

function collectCases(): Case[] {
  const cases: Case[] = [];

  function push(historyPath: string, profilePath: string | null, targetHint: string) {
    const events = load_history_file(historyPath);
    const profile = profilePath ? load_profile(profilePath) : null;
    const assessment = default_assessment();
    assessment.target = profile?.target ?? targetHint;
    assessment.test_basis = "synthetic_fixture";
    const file = path.relative(repo_root, historyPath).split(path.sep).join("/");
    cases.push({
      file,
      events,
      profile,
      findings: run_checkers(events, profile, assessment),
    });
  }

  const corpusRoot = path.join(repo_root, "corpus");
  for (const dir of fs.readdirSync(corpusRoot).sort()) {
    const dirPath = path.join(corpusRoot, dir);
    if (!fs.statSync(dirPath).isDirectory()) continue;
    const profilePath = path.join(dirPath, "profile.json");
    if (!fs.existsSync(profilePath)) continue;
    for (const name of fs.readdirSync(dirPath).sort()) {
      if (!name.endsWith(".jsonl")) continue;
      push(path.join(dirPath, name), profilePath, dir);
    }
  }

  const targetsRoot = path.join(repo_root, "targets");
  for (const t of fs.readdirSync(targetsRoot).sort()) {
    const hist = path.join(targetsRoot, t, "results", "history-fixture.jsonl");
    if (!fs.existsSync(hist)) continue;
    const candidates = [
      path.join(targetsRoot, t, "profile.json"),
      path.join(targetsRoot, t, "results", "profile.json"),
    ];
    push(hist, candidates.find((p) => fs.existsSync(p)) ?? null, t);
  }

  return cases;
}

const cases = collectCases();

describe("evidence: witness_seqs for supported|violation", () => {
  it("supported|violation findings have non-empty witness_seqs (except profile-only)", () => {
    const failures: string[] = [];
    for (const c of cases) {
      for (const f of c.findings) {
        if (f.result !== "supported" && f.result !== "violation") continue;
        if (isProfileOnly(f, c.profile)) {
          if (f.witness_seqs.length !== 0) {
            failures.push(`${c.file} ${f.invariant}: profile-only must keep witness_seqs=[] got [${f.witness_seqs}]`);
          }
          if (!/based on profile/i.test(f.explanation)) {
            failures.push(`${c.file} ${f.invariant}: profile-only explanation must say based on profile; got: ${f.explanation}`);
          }
          continue;
        }
        if (f.witness_seqs.length === 0) {
          failures.push(`${c.file} ${f.invariant}: result=${f.result} has empty witness_seqs`);
        }
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("every witness seq exists in that history", () => {
    const failures: string[] = [];
    for (const c of cases) {
      const seqs = new Set(c.events.map((e) => e.seq));
      for (const f of c.findings) {
        for (const s of f.witness_seqs) {
          if (!seqs.has(s)) {
            failures.push(`${c.file} ${f.invariant}: witness seq ${s} not in history`);
          }
        }
        // ascending unique
        const sorted = [...new Set(f.witness_seqs)].sort((a, b) => a - b);
        if (JSON.stringify(f.witness_seqs) !== JSON.stringify(sorted)) {
          failures.push(
            `${c.file} ${f.invariant}: witness_seqs not ascending unique: [${f.witness_seqs}]`,
          );
        }
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });
});

describe("evidence: reproducible", () => {
  it("reproducible === (observed_result !== not_tested)", () => {
    const failures: string[] = [];
    for (const c of cases) {
      for (const f of c.findings) {
        const expected = f.observed_result !== "not_tested";
        if (f.reproducible !== expected) {
          failures.push(
            `${c.file} ${f.invariant}: reproducible=${f.reproducible} observed_result=${f.observed_result} expected=${expected}`,
          );
        }
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });
});
