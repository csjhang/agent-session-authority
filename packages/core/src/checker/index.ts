import type { HistoryEvent } from "../history.js";
import type { AuthorityProfile, ClaimStatus } from "../declaration.js";
import { claimed_set } from "../declaration.js";
import type { AuthorityAssessment, CheckFinding, ResultLabel, TestBasis } from "../assessment.js";

/** Spec invariants vendors may claim (AUTH-08 has no checker but is in the profile). */
export const KNOWN_INVARIANTS = [
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
] as const;

/** Parent ids that cover lettered children (AUTH-01 → 01a/b/c). */
export const INVARIANT_PARENTS = ["AUTH-01", "AUTH-03"] as const;

export interface CheckerContext {
  events: HistoryEvent[];
  profile: AuthorityProfile | null;
  assessment: AuthorityAssessment;
}

export type Checker = (ctx: CheckerContext) => CheckFinding[];

export function basis(ctx: CheckerContext): TestBasis {
  return ctx.assessment.test_basis ?? "synthetic_fixture";
}

/**
 * Exact match, or parent covers children (AUTH-01 → AUTH-01a/b/c).
 * No prefix matching, no case folding.
 */
export function claim_for(ctx: CheckerContext, invariant: string): ClaimStatus {
  const claims = claimed_set(ctx.profile);
  if (!ctx.profile) return "not_declared";
  if (claims.size === 0) return "not_declared";
  if (claims.has(invariant)) return "declared";
  for (const parent of INVARIANT_PARENTS) {
    if (claims.has(parent) && invariant.length === parent.length + 1) {
      const suffix = invariant.slice(parent.length);
      if (invariant.startsWith(parent) && /^[a-z]$/.test(suffix)) return "declared";
    }
  }
  return "not_declared";
}

export function finding(
  invariant: string,
  claim_status: ClaimStatus,
  result: ResultLabel,
  explanation: string,
  witness_seqs: number[] = [],
  test_basis: TestBasis = "synthetic_fixture",
): CheckFinding {
  const observed_result = result;
  let final_result = result;
  let final_explanation = explanation;

  // out_of_scope: nothing produces it today; skipped (see PR body).

  if (result === "not_tested") {
    final_result = "not_tested";
  } else if (claim_status === "underspecified" && result !== "violation") {
    final_result = "underspecified";
  } else if (
    claim_status === "not_declared" &&
    (test_basis === "research_profile" || test_basis === "vendor_claim")
  ) {
    if (result === "supported" || result === "violation") {
      final_result = "not_declared";
      final_explanation =
        `not graded: ${invariant} is not in claimed_invariants (test_basis=${test_basis}). ` +
        `Observed ${observed_result}: ${explanation}`;
    }
    // inconclusive / not_tested: do not rewrite
  }
  // synthetic_fixture: result = observed (unchanged)
  // research_profile/vendor_claim + declared: result = observed

  return {
    invariant,
    claim_status,
    result: final_result,
    observed_result,
    witness_seqs,
    explanation: final_explanation,
    reproducible: true,
    test_basis,
  };
}

/** Return not_tested for empty history and inconclusive for incomplete evidence. */
export function observation_guard(ctx: CheckerContext, invariant: string, prerequisites: boolean, sufficient_observations: boolean): CheckFinding[] | undefined {
  const cs = claim_for(ctx, invariant);
  if (ctx.events.length === 0) return [finding(invariant, cs, "not_tested", "Scenario did not run: history is empty.", [], basis(ctx))];
  if (!prerequisites || !sufficient_observations) return [finding(invariant, cs, "inconclusive", !prerequisites ? "Required prerequisite observations are absent." : "Not enough observations for a positive conclusion.", [], basis(ctx))];
  return undefined;
}

export function attrs(ev: HistoryEvent): Record<string, unknown> {
  return ev.attrs ?? {};
}

export function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
