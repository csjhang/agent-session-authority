import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { load_history_file } from "../src/history.js";
import { load_profile } from "../src/declaration.js";
import { default_assessment, type TestBasis } from "../src/assessment.js";
import { run_checkers } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo_root = path.resolve(here, "../../..");
const SNAPSHOT_PATH = path.join(here, "fixtures", "verdict-snapshot.json");

type SnapshotEntry = {
  file: string;
  invariant: string;
  test_basis: TestBasis;
  observed_result: string;
  result: string;
};

const SNAPSHOT_BASES: TestBasis[] = ["synthetic_fixture", "research_profile"];

function collectCurrent(): SnapshotEntry[] {
  const rows: SnapshotEntry[] = [];

  function assess(historyPath: string, profilePath: string | null, targetHint: string) {
    const events = load_history_file(historyPath, { warn_unknown_vocab: false });
    const profile = profilePath ? load_profile(profilePath) : null;
    const file = path.relative(repo_root, historyPath).split(path.sep).join("/");
    for (const test_basis of SNAPSHOT_BASES) {
      const assessment = default_assessment();
      assessment.target = profile?.target ?? targetHint;
      assessment.test_basis = test_basis;
      for (const f of run_checkers(events, profile, assessment)) {
        rows.push({
          file,
          invariant: f.invariant,
          test_basis,
          observed_result: f.observed_result,
          result: f.result,
        });
      }
    }
  }

  const corpusRoot = path.join(repo_root, "corpus");
  for (const dir of fs.readdirSync(corpusRoot).sort()) {
    const dirPath = path.join(corpusRoot, dir);
    if (!fs.statSync(dirPath).isDirectory()) continue;
    const profilePath = path.join(dirPath, "profile.json");
    if (!fs.existsSync(profilePath)) continue;
    for (const name of fs.readdirSync(dirPath).sort()) {
      if (!name.endsWith(".jsonl")) continue;
      assess(path.join(dirPath, name), profilePath, dir);
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
    const profilePath = candidates.find((p) => fs.existsSync(p)) ?? null;
    assess(hist, profilePath, t);
  }

  rows.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.invariant.localeCompare(b.invariant) ||
      a.test_basis.localeCompare(b.test_basis),
  );
  return rows;
}

describe("verdict snapshot", () => {
  it("current observed_result/result equal committed snapshot exactly", () => {
    expect(fs.existsSync(SNAPSHOT_PATH)).toBe(true);
    const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8")) as SnapshotEntry[];
    const current = collectCurrent();
    expect(current).toEqual(snapshot);
  });
});

