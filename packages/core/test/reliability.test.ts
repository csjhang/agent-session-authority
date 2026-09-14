import { describe, expect, it } from "vitest";
import { default_assessment } from "../src/assessment.js";
import { parse_history_jsonl } from "../src/history.js";
import { run_checkers } from "../src/index.js";

describe("reliability judgment premises", () => {
  it("does not turn an empty research-profile run into supported/declared", () => {
    const assessment = default_assessment();
    assessment.test_basis = "research_profile";
    const findings = run_checkers([], null, assessment);
    for (const inv of ["AUTH-02", "AUTH-03a", "AUTH-03b", "AUTH-03c", "AUTH-04", "AUTH-05", "AUTH-06", "AUTH-07"]) {
      const f = findings.find((x) => x.invariant === inv)!;
      expect(f.result).toBe("not_tested");
      expect(f.claim_status).toBe("not_declared");
    }
  });

  it("marks missing prerequisites inconclusive", () => {
    const events = parse_history_jsonl("{\"seq\":1,\"kind\":\"ok\",\"op\":\"action.bind\",\"attrs\":{\"action_digest\":\"d\"}}", { warn_unknown_vocab: false });
    const assessment = default_assessment();
    assessment.test_basis = "research_profile";
    const finding = run_checkers(events, null, assessment).find((x) => x.invariant === "AUTH-02")!;
    expect(finding.result).toBe("inconclusive");
    expect(finding.claim_status).toBe("not_declared");
  });

  it("keeps AUTH-05 observable counterexample after self-report markers are removed", () => {
    const events = parse_history_jsonl([
      "{\"seq\":1,\"kind\":\"ok\",\"op\":\"approval.grant\",\"actor_id\":\"approver\",\"attrs\":{\"approver\":\"approver\",\"decision\":\"grant\",\"role\":\"approver\",\"policy\":\"approval-v1\"}}", 
      "{\"seq\":2,\"kind\":\"ok\",\"op\":\"lease.acquire\",\"actor_id\":\"approver\",\"attrs\":{\"holder\":\"approver\",\"accepted\":true,\"role\":\"approver\",\"permissions\":[\"effect.dispatch\"],\"policy\":\"approval-v1\"}}", 
      "{\"seq\":3,\"kind\":\"ok\",\"op\":\"effect.dispatch\",\"actor_id\":\"approver\",\"attrs\":{\"role\":\"approver\",\"status\":\"dispatched\",\"policy\":\"approval-v1\"}}"
    ].join("\n"), { warn_unknown_vocab: false });
    const profile = { profile_version: "0.2", target: "markerless-auth05", claimed_invariants: ["AUTH-05"] };
    const finding = run_checkers(events, profile, default_assessment()).find((x) => x.invariant === "AUTH-05")!;
    expect(finding.result).toBe("violation");
    expect(finding.witness_seqs).toEqual(expect.arrayContaining([1, 2]));
    expect(finding.explanation).toMatch(/approver|ControlLease/);
  });

  it("AUTH-06 completes without inventing receipts (empty / violate / clean dispatch)", () => {
    const assessment = default_assessment();
    assessment.test_basis = "research_profile";
    const empty = run_checkers([], null, assessment).find((x) => x.invariant === "AUTH-06")!;
    expect(empty.result).toBe("not_tested");

    const violate_events = parse_history_jsonl(
      [
        "{\"seq\":1,\"kind\":\"ok\",\"op\":\"effect.dispatch\",\"attrs\":{\"effect_id\":\"e1\",\"status\":\"dispatched\"}}",
        "{\"seq\":2,\"kind\":\"info\",\"op\":\"effect.dispatch\",\"attrs\":{\"effect_id\":\"e1\",\"status\":\"completed\"}}",
      ].join("\n"),
      { warn_unknown_vocab: false },
    );
    const violate = run_checkers(violate_events, null, assessment).find((x) => x.invariant === "AUTH-06")!;
    expect(violate.result).toBe("violation");
    expect(violate.witness_seqs).toEqual(expect.arrayContaining([2]));

    const clean = parse_history_jsonl(
      "{\"seq\":1,\"kind\":\"ok\",\"op\":\"effect.dispatch\",\"attrs\":{\"effect_id\":\"e1\",\"status\":\"dispatched\"}}",
      { warn_unknown_vocab: false },
    );
    const clean_finding = run_checkers(clean, null, assessment).find((x) => x.invariant === "AUTH-06")!;
    // No success claim without receipt — not a violation; do not invent a receipt.
    expect(clean_finding.result).not.toBe("violation");
    expect(clean_finding.result).not.toBe("not_tested");
  });

  it("AUTH-07 observation_guard is wired (no ReferenceError on empty history)", () => {
    const assessment = default_assessment();
    assessment.test_basis = "research_profile";
    const f = run_checkers([], null, assessment).find((x) => x.invariant === "AUTH-07")!;
    expect(f.result).toBe("not_tested");
  });
});
