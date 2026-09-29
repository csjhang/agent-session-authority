import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { load_history_file } from "../src/history.js";
import { load_profile } from "../src/declaration.js";
import { default_assessment } from "../src/assessment.js";
import { run_checkers } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo_root = path.resolve(here, "../../..");

function run_corpus(dir: string) {
  const history_pass = load_history_file(path.join(repo_root, "corpus", dir, "pass.jsonl"));
  const history_violate = load_history_file(path.join(repo_root, "corpus", dir, "violate.jsonl"));
  const profile = load_profile(path.join(repo_root, "corpus", dir, "profile.json"));
  const assessment = default_assessment();
  assessment.target = profile?.target ?? dir;
  assessment.test_basis = "synthetic_fixture";
  return {
    pass: run_checkers(history_pass, profile, assessment),
    violate: run_checkers(history_violate, profile, assessment),
  };
}

function by_inv(findings: ReturnType<typeof run_checkers>, inv: string) {
  return findings.filter((f) => f.invariant === inv || f.invariant.startsWith(inv));
}

describe("golden corpus AUTH-01", () => {
  it("pass has no AUTH-01b violation", () => {
    const { pass } = run_corpus("auth01");
    const f = by_inv(pass, "AUTH-01b");
    expect(f.every((x) => x.result !== "violation")).toBe(true);
    expect(f.some((x) => x.result === "supported")).toBe(true);
  });
  it("violate catches AUTH-01b with witness seqs", () => {
    const { violate } = run_corpus("auth01");
    const f = by_inv(violate, "AUTH-01b").find((x) => x.result === "violation");
    expect(f).toBeTruthy();
    expect(f!.witness_seqs.length).toBeGreaterThan(0);
    expect(f!.witness_seqs).toEqual(expect.arrayContaining([3, 4, 5]));
  });
});

describe("golden corpus AUTH-02", () => {
  it("pass supported", () => {
    const { pass } = run_corpus("auth02");
    expect(by_inv(pass, "AUTH-02")[0]?.result).toBe("supported");
  });
  it("violate catches binding change after approval", () => {
    const { violate } = run_corpus("auth02");
    const f = by_inv(violate, "AUTH-02").find((x) => x.result === "violation");
    expect(f).toBeTruthy();
    expect(f!.witness_seqs.length).toBeGreaterThan(0);
    expect(f!.witness_seqs).toEqual(expect.arrayContaining([1, 2, 3]));
  });
  it("once_grant_reused when allow_once grant covers two effect_ids", () => {
    const history = load_history_file(path.join(repo_root, "corpus", "auth02", "violate-once-grant-reused.jsonl"));
    const profile = load_profile(path.join(repo_root, "corpus", "auth02", "profile.json"));
    const f = by_inv(run_checkers(history, profile, default_assessment()), "AUTH-02").find((x) => x.result === "violation");
    expect(f).toBeTruthy();
    expect(f!.explanation).toMatch(/once_grant_reused/);
  });
  it("supported explanation notes unlinked committed receipts", () => {
    const history = load_history_file(path.join(repo_root, "corpus", "auth02", "pass-with-unlinked.jsonl"));
    const profile = load_profile(path.join(repo_root, "corpus", "auth02", "profile.json"));
    const f = by_inv(run_checkers(history, profile, default_assessment()), "AUTH-02")[0];
    expect(f?.result).toBe("supported");
    expect(f!.explanation).toMatch(/unlinked committed receipt/);
    expect(f!.explanation).toMatch(/witness_seqs=\[4\]/);
  });
});

describe("golden corpus AUTH-03", () => {
  it("pass supports AUTH-03b/c", () => {
    const { pass } = run_corpus("auth03");
    expect(by_inv(pass, "AUTH-03b")[0]?.result).toBe("supported");
    expect(by_inv(pass, "AUTH-03c")[0]?.result).toBe("supported");
  });
  it("violate catches dual lease and/or scope coverage", () => {
    const { violate } = run_corpus("auth03");
    const v = violate.filter((x) => x.result === "violation");
    expect(v.length).toBeGreaterThan(0);
    expect(v.some((x) => x.invariant.startsWith("AUTH-03"))).toBe(true);
    expect(v.some((x) => x.witness_seqs.length > 0)).toBe(true);
  });
  it("AUTH-03c handoff without from/actor_id strips scope from all but to", () => {
    const history = load_history_file(path.join(repo_root, "corpus", "auth03", "violate-handoff-no-from.jsonl"));
    const profile = load_profile(path.join(repo_root, "corpus", "auth03", "profile.json"));
    const f = by_inv(run_checkers(history, profile, default_assessment()), "AUTH-03c").find((x) => x.result === "violation");
    expect(f).toBeTruthy();
    expect(f!.explanation).toMatch(/not covered/);
  });
  it("AUTH-03c lease expires_at + committed receipt missing ts → inconclusive (cannot judge expiry)", () => {
    const history = load_history_file(path.join(repo_root, "corpus", "auth03", "inconclusive-missing-receipt-ts.jsonl"));
    const profile = load_profile(path.join(repo_root, "corpus", "auth03", "profile.json"));
    const f = by_inv(run_checkers(history, profile, default_assessment()), "AUTH-03c")[0];
    expect(f?.result).toBe("inconclusive");
    expect(f!.explanation).toMatch(/no committed receipt evaluated/);
    expect(f!.explanation).toMatch(/cannot judge expiry|missing ts/);
    expect(f!.witness_seqs).toEqual(expect.arrayContaining([2]));
  });
});

describe("golden corpus AUTH-04", () => {
  it("pass supported (stale rejected at gateway)", () => {
    const { pass } = run_corpus("auth04");
    expect(by_inv(pass, "AUTH-04")[0]?.result).toBe("supported");
  });
  it("violate catches stale fence commit at boundary", () => {
    const { violate } = run_corpus("auth04");
    const f = by_inv(violate, "AUTH-04").find((x) => x.result === "violation");
    expect(f).toBeTruthy();
    expect(f!.witness_seqs).toEqual(expect.arrayContaining([4]));
  });
  it("lower-epoch lease.acquire after handoff must not update live holder", () => {
    const history = load_history_file(path.join(repo_root, "corpus", "auth04", "violate-lower-epoch-acquire.jsonl"));
    const profile = load_profile(path.join(repo_root, "corpus", "auth04", "profile.json"));
    const f = by_inv(run_checkers(history, profile, default_assessment()), "AUTH-04").find((x) => x.result === "violation");
    expect(f).toBeTruthy();
    expect(f!.explanation).toMatch(/not live holder/);
  });
  it("only rejected receipt → AUTH-04 inconclusive (no committed evidence)", () => {
    const history = load_history_file(path.join(repo_root, "corpus", "auth04", "inconclusive-rejected-only.jsonl"));
    const profile = load_profile(path.join(repo_root, "corpus", "auth04", "profile.json"));
    const f = by_inv(run_checkers(history, profile, default_assessment()), "AUTH-04")[0];
    expect(f?.result).toBe("inconclusive");
    expect(f!.explanation).toMatch(/no committed receipt evaluated/);
  });
  it("after handoff, committed receipt missing controller → inconclusive", () => {
    const history = load_history_file(path.join(repo_root, "corpus", "auth04", "inconclusive-missing-controller.jsonl"));
    const profile = load_profile(path.join(repo_root, "corpus", "auth04", "profile.json"));
    const f = by_inv(run_checkers(history, profile, default_assessment()), "AUTH-04")[0];
    expect(f?.result).toBe("inconclusive");
    expect(f!.explanation).toMatch(/missing controller/);
    expect(f!.explanation).toMatch(/no committed receipt evaluated\. Committed/);
  });
  it("auth04 pass has no AUTH-02 (or other) violation", () => {
    const { pass } = run_corpus("auth04");
    expect(pass.filter((x) => x.result === "violation")).toEqual([]);
    expect(by_inv(pass, "AUTH-04")[0]?.result).toBe("supported");
    expect(by_inv(pass, "AUTH-02")[0]?.result).toBe("supported");
  });
});

describe("golden corpus AUTH-05", () => {
  it("pass supported", () => {
    const { pass } = run_corpus("auth05");
    expect(by_inv(pass, "AUTH-05")[0]?.result).toBe("supported");
  });
  it("violate with witness", () => {
    const { violate } = run_corpus("auth05");
    const f = by_inv(violate, "AUTH-05").find((x) => x.result === "violation");
    expect(f).toBeTruthy();
    expect(f!.witness_seqs.length).toBeGreaterThan(0);
  });
});

describe("golden corpus AUTH-06", () => {
  it("pass supported", () => {
    const { pass } = run_corpus("auth06");
    expect(by_inv(pass, "AUTH-06")[0]?.result).toBe("supported");
  });
  it("violate catches implicit success; fail!=info", () => {
    const { violate } = run_corpus("auth06");
    const f = by_inv(violate, "AUTH-06").find((x) => x.result === "violation");
    expect(f).toBeTruthy();
    expect(f!.witness_seqs).toEqual(expect.arrayContaining([2]));
  });
});

describe("golden corpus AUTH-07", () => {
  it("pass supported with reconcile + published rules", () => {
    const { pass } = run_corpus("auth07");
    expect(by_inv(pass, "AUTH-07")[0]?.result).toBe("supported");
  });
  it("violate catches ambiguous/wrong terminal", () => {
    const { violate } = run_corpus("auth07");
    const f = by_inv(violate, "AUTH-07").find((x) => x.result === "violation");
    expect(f).toBeTruthy();
    expect(f!.witness_seqs.length).toBeGreaterThan(0);
  });
});

describe("label distinctions", () => {
  it("every corpus/**/pass*.jsonl has no violation on any invariant", () => {
    const corpus_root = path.join(repo_root, "corpus");
    const dirs = fs.readdirSync(corpus_root, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const d of dirs) {
      const dir = path.join(corpus_root, d.name);
      const profile_path = path.join(dir, "profile.json");
      if (!fs.existsSync(profile_path)) continue;
      const profile = load_profile(profile_path);
      for (const name of fs.readdirSync(dir)) {
        if (!name.startsWith("pass") || !name.endsWith(".jsonl")) continue;
        const history = load_history_file(path.join(dir, name));
        const findings = run_checkers(history, profile, default_assessment());
        const viol = findings.filter((x) => x.result === "violation");
        expect(viol, `${d.name}/${name}`).toEqual([]);
      }
    }
  });
  it("AUTH-02/04/07 results are not not_tested when implemented", () => {
    const { pass } = run_corpus("auth02");
    expect(by_inv(pass, "AUTH-02")[0]?.result).not.toBe("not_tested");
    const a4 = run_corpus("auth04");
    expect(by_inv(a4.pass, "AUTH-04")[0]?.result).not.toBe("not_tested");
    const a7 = run_corpus("auth07");
    expect(by_inv(a7.pass, "AUTH-07")[0]?.result).not.toBe("not_tested");
  });
  it("claim_status remains independent of result on auth01 profile", () => {
    const { pass } = run_corpus("auth01");
    for (const inv of ["AUTH-02", "AUTH-04", "AUTH-07"]) {
      const f = pass.find((x) => x.invariant === inv);
      expect(["not_declared","declared"]).toContain(f?.claim_status);
      expect(f?.result).not.toBe("not_tested");
      expect(f?.result).not.toBe(f?.claim_status);
    }
  });
});

const ACP_SHAPED_CASES: Array<{ file: string; result: "supported" | "violation" | "inconclusive" }> = [
  { file: "a1-reask-after-restart.jsonl", result: "supported" },
  { file: "a2-stale-grant-no-reask.jsonl", result: "violation" },
  { file: "a3-deny-then-committed.jsonl", result: "violation" },
  { file: "a4-no-request-committed.jsonl", result: "inconclusive" },
  { file: "a5-unknown-only.jsonl", result: "inconclusive" },
  { file: "a6-orphan-only.jsonl", result: "violation" },
  { file: "a7-deny-restart-reask-same-action.jsonl", result: "supported" },
];

const BAD_REBOUND = /rebound with changed fields \((?:[^)]*\b(?:runtime_generation|nonce|expiry)\b[^)]*)\)/;

describe("golden corpus ACP-shaped AUTH-02", () => {
  const profile = load_profile(path.join(repo_root, "corpus", "acp-shaped", "profile.json"));
  for (const { file, result } of ACP_SHAPED_CASES) {
    it(`${file} → AUTH-02 ${result} with non-empty witness_seqs when applicable`, () => {
      const history = load_history_file(path.join(repo_root, "corpus", "acp-shaped", file));
      const assessment = default_assessment();
      assessment.target = "acp-shaped";
      assessment.test_basis = "synthetic_fixture";
      const findings = run_checkers(history, profile, assessment);
      const f = by_inv(findings, "AUTH-02")[0];
      expect(f?.result).toBe(result);
      expect(f!.witness_seqs.length).toBeGreaterThan(0);
      expect(f!.explanation ?? "").not.toMatch(BAD_REBOUND);
    });
  }

  it("AUTH-01b supported explanation notes probe-derived generation when field_provenance marks it", () => {
    const history = load_history_file(path.join(repo_root, "corpus", "acp-shaped", "a1-reask-after-restart.jsonl"));
    const assessment = default_assessment();
    assessment.test_basis = "synthetic_fixture";
    const f = by_inv(run_checkers(history, profile, assessment), "AUTH-01b")[0];
    expect(f?.result).toBe("supported");
    expect(f?.explanation).toMatch(/generation derived by probe, not target-native/);
  });
});

describe("marker-free violate corpora", () => {
  it("AUTH-02 deny-then-commit without markers", () => {
    const history = load_history_file(path.join(repo_root, "corpus", "auth02", "violate-markerfree.jsonl"));
    const profile = load_profile(path.join(repo_root, "corpus", "auth02", "profile.json"));
    const f = by_inv(run_checkers(history, profile, default_assessment()), "AUTH-02").find((x) => x.result === "violation");
    expect(f).toBeTruthy();
    expect(f!.explanation).toMatch(/committed_after_deny/);
    expect(f!.explanation).not.toMatch(/test-injected marker/);
    expect(f!.witness_seqs.length).toBeGreaterThan(0);
  });

  it("AUTH-04 wrong holder after same-epoch handoff", () => {
    const history = load_history_file(path.join(repo_root, "corpus", "auth04", "violate-markerfree.jsonl"));
    const profile = load_profile(path.join(repo_root, "corpus", "auth04", "profile.json"));
    const f = by_inv(run_checkers(history, profile, default_assessment()), "AUTH-04").find((x) => x.result === "violation");
    expect(f).toBeTruthy();
    expect(f!.explanation).toMatch(/not live holder/);
    expect(f!.explanation).not.toMatch(/test-injected marker/);
  });

  it("AUTH-05 grantor acquires lease without markers", () => {
    const history = load_history_file(path.join(repo_root, "corpus", "auth05", "violate-markerfree.jsonl"));
    const profile = load_profile(path.join(repo_root, "corpus", "auth05", "profile.json"));
    const f = by_inv(run_checkers(history, profile, default_assessment()), "AUTH-05").find((x) => x.result === "violation");
    expect(f).toBeTruthy();
    expect(f!.explanation).not.toMatch(/test-injected marker/);
  });

  it("AUTH-06 non-committed receipt cannot support success", () => {
    const history = load_history_file(path.join(repo_root, "corpus", "auth06", "violate-noncommitted-receipt.jsonl"));
    const profile = load_profile(path.join(repo_root, "corpus", "auth06", "profile.json"));
    const f = by_inv(run_checkers(history, profile, default_assessment()), "AUTH-06").find((x) => x.result === "violation");
    expect(f).toBeTruthy();
    expect(f!.witness_seqs).toEqual(expect.arrayContaining([3]));
  });

  it("AUTH-07 conflicting published terminals without markers", () => {
    const history = load_history_file(path.join(repo_root, "corpus", "auth07", "violate-markerfree.jsonl"));
    const profile = load_profile(path.join(repo_root, "corpus", "auth07", "profile.json"));
    const f = by_inv(run_checkers(history, profile, default_assessment()), "AUTH-07").find((x) => x.result === "violation");
    expect(f).toBeTruthy();
    expect(f!.explanation).not.toMatch(/test-injected marker/);
  });

  it("AUTH-03c handoff moves scope; expiry not covered", () => {
    const history = load_history_file(path.join(repo_root, "corpus", "auth03", "violate-handoff-expiry.jsonl"));
    const profile = load_profile(path.join(repo_root, "corpus", "auth03", "profile.json"));
    const f = by_inv(run_checkers(history, profile, default_assessment()), "AUTH-03c").find((x) => x.result === "violation");
    expect(f).toBeTruthy();
    expect(f!.explanation).toMatch(/not covered|expires_at/);
  });
});
