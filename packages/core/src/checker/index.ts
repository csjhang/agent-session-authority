import type { HistoryEvent } from "../history.js";
import type { AuthorityProfile, ClaimStatus } from "../declaration.js";
import { claimed_set } from "../declaration.js";
import type { AuthorityAssessment, CheckFinding, ResultLabel, TestBasis } from "../assessment.js";

export interface CheckerContext {
  events: HistoryEvent[];
  profile: AuthorityProfile | null;
  assessment: AuthorityAssessment;
}

export type Checker = (ctx: CheckerContext) => CheckFinding[];

export function basis(ctx: CheckerContext): TestBasis {
  return ctx.assessment.test_basis ?? "synthetic_fixture";
}

export function claim_for(ctx: CheckerContext, invariant: string): ClaimStatus {
  const claims = claimed_set(ctx.profile);
  if (!ctx.profile) return "not_declared";
  if (claims.size === 0) return "not_declared";
  const prefixes = [invariant, invariant.split(".")[0] ?? invariant];
  for (const p of prefixes) {
    if (claims.has(p)) return "declared";
  }
  // AUTH-01a/b/c match AUTH-01 claim
  const parent = invariant.replace(/[a-c]$/, "");
  if (parent !== invariant && claims.has(parent)) return "declared";
  if ([...claims].some((c) => invariant.startsWith(c) || c.startsWith(invariant))) {
    return "declared";
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
  // claim_status is an independent axis; do not manufacture declarations.
  let final_result = result;
  if (result === "not_tested") {
    final_result = "not_tested";
  } else if (claim_status === "not_declared" && result === "supported") {
    // synthetic fixtures may still show supported behavior without a vendor claim
    if (test_basis === "synthetic_fixture") final_result = result;
    else final_result = "not_declared";
  } else if (claim_status === "underspecified" && result !== "violation") {
    final_result = "underspecified";
  }
  return {
    invariant,
    claim_status,
    result: final_result,
    witness_seqs,
    explanation,
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
