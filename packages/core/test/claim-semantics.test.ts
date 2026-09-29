import { describe, expect, it } from "vitest";
import { default_assessment, type ResultLabel, type TestBasis } from "../src/assessment.js";
import type { ClaimStatus } from "../src/declaration.js";
import { parse_history_jsonl } from "../src/history.js";
import { run_checkers } from "../src/index.js";
import { build_report, format_report } from "../src/report.js";
import {
  claim_for,
  finding,
  KNOWN_INVARIANTS,
  INVARIANT_PARENTS,
  type CheckerContext,
} from "../src/checker/index.js";

const ALL_RESULTS: ResultLabel[] = ["supported", "violation", "inconclusive", "not_tested"];
const BASES: TestBasis[] = ["synthetic_fixture", "research_profile", "vendor_claim"];

function ctx_for(claimed: string[] | null, test_basis: TestBasis = "synthetic_fixture"): CheckerContext {
  return {
    events: [],
    profile: claimed
      ? { profile_version: "0.2", target: "t", claimed_invariants: claimed }
      : null,
    assessment: { ...default_assessment(), test_basis },
  };
}

describe("finding() claim rewrite matrix", () => {
  for (const test_basis of BASES) {
    for (const claim_status of ["declared", "not_declared"] as ClaimStatus[]) {
      for (const observed of ALL_RESULTS) {
        it(`${test_basis} + claim_status=${claim_status} + observed=${observed}`, () => {
          const original = `raw explanation for ${observed}`;
          const f = finding("AUTH-06", claim_status, observed, original, [2, 9], test_basis);
          expect(f.observed_result).toBe(observed);
          expect(f.witness_seqs).toEqual([2, 9]);

          let expected: ResultLabel = observed;
          if (test_basis === "synthetic_fixture") {
            expected = observed;
          } else if (claim_status === "declared") {
            expected = observed;
          } else if (claim_status === "not_declared") {
            if (observed === "supported" || observed === "violation") expected = "not_declared";
            else expected = observed; // inconclusive / not_tested unchanged
          }
          expect(f.result).toBe(expected);

          if (expected === "not_declared" && (observed === "supported" || observed === "violation")) {
            expect(f.explanation).toBe(
              `not graded: AUTH-06 is not in claimed_invariants (test_basis=${test_basis}). Observed ${observed}: ${original}`,
            );
          } else {
            expect(f.explanation).toBe(original);
          }
        });
      }
    }
  }

  it("underspecified keeps non-violation as underspecified and records observed_result", () => {
    const f = finding("AUTH-02", "underspecified", "supported", "ok", [], "research_profile");
    expect(f.observed_result).toBe("supported");
    expect(f.result).toBe("underspecified");
  });

  it("underspecified leaves violation as violation", () => {
    const f = finding("AUTH-02", "underspecified", "violation", "bad", [1], "research_profile");
    expect(f.observed_result).toBe("violation");
    expect(f.result).toBe("violation");
  });
});

describe("E2E research_profile / vendor_claim undeclared AUTH-06 counterexample", () => {
  const violate_events = parse_history_jsonl(
    [
      '{"seq":1,"kind":"ok","op":"effect.dispatch","attrs":{"effect_id":"e1","status":"dispatched"}}',
      '{"seq":2,"kind":"info","op":"effect.dispatch","attrs":{"effect_id":"e1","status":"completed"}}',
    ].join("\n"),
    { warn_unknown_vocab: false },
  );

  for (const test_basis of ["research_profile", "vendor_claim"] as TestBasis[]) {
    it(`${test_basis} + no profile → capability_vector not_declared, observed_vector violation`, () => {
      const assessment = { ...default_assessment(), test_basis };
      const findings = run_checkers(violate_events, null, assessment);
      const report = build_report(findings, assessment, null);
      expect(report.capability_vector["AUTH-06"]).toBe("not_declared");
      expect(report.observed_vector["AUTH-06"]).toBe("violation");
      const f = findings.find((x) => x.invariant === "AUTH-06")!;
      expect(f.result).toBe("not_declared");
      expect(f.observed_result).toBe("violation");
      expect(f.witness_seqs).toEqual(expect.arrayContaining([2]));
      expect(f.explanation).toMatch(/Observed violation/);
    });

    it(`${test_basis} + AUTH-06 claimed → result violation`, () => {
      const assessment = { ...default_assessment(), test_basis };
      const profile = { profile_version: "0.2", target: "t", claimed_invariants: ["AUTH-06"] };
      const findings = run_checkers(violate_events, profile, assessment);
      const report = build_report(findings, assessment, profile);
      expect(report.capability_vector["AUTH-06"]).toBe("violation");
      expect(report.observed_vector["AUTH-06"]).toBe("violation");
      const f = findings.find((x) => x.invariant === "AUTH-06")!;
      expect(f.result).toBe("violation");
      expect(f.observed_result).toBe("violation");
      expect(f.claim_status).toBe("declared");
    });
  }
});

describe("claim_for exact / parent matching", () => {
  const INVS = [
    "AUTH-01a",
    "AUTH-01b",
    "AUTH-01c",
    "AUTH-02",
    "AUTH-03a",
    "AUTH-03b",
    "AUTH-03c",
    "AUTH-04",
    "AUTH-05",
    "AUTH-06",
    "AUTH-07",
  ] as const;

  function declared_of(claimed: string[]): string[] {
    const ctx = ctx_for(claimed);
    return INVS.filter((inv) => claim_for(ctx, inv) === "declared");
  }

  it('["AUTH-01"] → only 01a/b/c', () => {
    expect(declared_of(["AUTH-01"])).toEqual(["AUTH-01a", "AUTH-01b", "AUTH-01c"]);
  });

  it('["AUTH-01a"] → only 01a', () => {
    expect(declared_of(["AUTH-01a"])).toEqual(["AUTH-01a"]);
  });

  it('["AUTH-03"] → only 03a/b/c', () => {
    expect(declared_of(["AUTH-03"])).toEqual(["AUTH-03a", "AUTH-03b", "AUTH-03c"]);
  });

  it('["AUTH-02"] → only 02', () => {
    expect(declared_of(["AUTH-02"])).toEqual(["AUTH-02"]);
  });

  for (const bad of [["AUTH-0"], [""], ["AUTH"], ["A"], ["auth-02"]] as string[][]) {
    it(`${JSON.stringify(bad)} → all not_declared`, () => {
      expect(declared_of(bad)).toEqual([]);
    });
  }

  it("KNOWN_INVARIANTS includes AUTH-08 and the 11 checker ids", () => {
    expect(KNOWN_INVARIANTS).toEqual([
      "AUTH-01a",
      "AUTH-01b",
      "AUTH-01c",
      "AUTH-02",
      "AUTH-03a",
      "AUTH-03b",
      "AUTH-03c",
      "AUTH-04",
      "AUTH-05",
      "AUTH-06",
      "AUTH-07",
      "AUTH-08",
    ]);
    expect(INVARIANT_PARENTS).toEqual(["AUTH-01", "AUTH-03"]);
  });
});

describe("unknown_claims in build_report", () => {
  it("lists claimed ids that are neither known nor parents", () => {
    const assessment = default_assessment();
    const profile = {
      profile_version: "0.2",
      target: "t",
      claimed_invariants: ["AUTH-0", "", "AUTH", "auth-02", "AUTH-99"],
    };
    // Empty findings still produce unknown_claims from profile
    const report = build_report([], assessment, profile);
    expect(report.unknown_claims).toEqual(["AUTH-0", "", "AUTH", "auth-02", "AUTH-99"]);
    const text = format_report(report);
    expect(text).toMatch(/unknown_claims/);
    expect(text).toMatch(/AUTH-99/);
  });

  it('["AUTH-01","AUTH-08"] → empty unknown_claims', () => {
    const assessment = default_assessment();
    const profile = {
      profile_version: "0.2",
      target: "t",
      claimed_invariants: ["AUTH-01", "AUTH-08"],
    };
    const report = build_report([], assessment, profile);
    expect(report.unknown_claims).toEqual([]);
  });
});
