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
