import type { AuthorityAssessment, CheckFinding, ResultLabel } from "./assessment.js";
import type { AuthorityProfile, ClaimStatus } from "./declaration.js";
import { KNOWN_INVARIANTS, INVARIANT_PARENTS } from "./checker/index.js";

/**
 * Capability vector uses `result` only.
 * `claim_status` is a separate axis — never conflate:
 *   - result=not_tested  → checker not implemented / not run
 *   - claim_status=not_declared → profile does not claim the invariant
 * A finding may be result=not_tested AND claim_status=not_declared simultaneously.
 *
 * `observed_result` is the checker's raw conclusion before claim rewrite;
 * `result` is the claim-rewritten grade.
 */
export interface CapabilityVectorReport {
  target: string;
  profile_version: string;
  test_basis: string;
  findings: CheckFinding[];
  /** Per-invariant checker result after claim rewrite (includes not_tested). */
  capability_vector: Record<string, ResultLabel>;
  /** Per-invariant raw checker conclusion before claim rewrite. */
  observed_vector: Record<string, ResultLabel>;
  /** Per-invariant declaration status from the profile (includes not_declared). */
  claim_status_vector: Record<string, ClaimStatus>;
  /** claimed_invariants ids that are neither KNOWN_INVARIANTS nor INVARIANT_PARENTS. */
  unknown_claims: string[];
}

const KNOWN_OR_PARENT = new Set<string>([...KNOWN_INVARIANTS, ...INVARIANT_PARENTS]);

export function build_report(
  findings: CheckFinding[],
  assessment: AuthorityAssessment,
  profile: AuthorityProfile | null,
): CapabilityVectorReport {
  const capability_vector: Record<string, ResultLabel> = {};
  const observed_vector: Record<string, ResultLabel> = {};
  const claim_status_vector: Record<string, ClaimStatus> = {};
  for (const f of findings) {
    capability_vector[f.invariant] = f.result;
    observed_vector[f.invariant] = f.observed_result;
    claim_status_vector[f.invariant] = f.claim_status;
  }
  const unknown_claims: string[] = [];
  for (const id of profile?.claimed_invariants ?? []) {
    if (!KNOWN_OR_PARENT.has(id)) unknown_claims.push(id);
  }
  return {
    target: assessment.target ?? "unknown",
    profile_version: assessment.profile_version ?? "0.2",
    test_basis: assessment.test_basis ?? "synthetic_fixture",
    findings,
    capability_vector,
    observed_vector,
    claim_status_vector,
    unknown_claims,
  };
}

export function format_report(report: CapabilityVectorReport): string {
  const lines: string[] = [];
  lines.push(`target: ${report.target}`);
  lines.push(`profile_version: ${report.profile_version}`);
  lines.push(`test_basis: ${report.test_basis}`);
  lines.push("capability_vector (result):");
  for (const [k, v] of Object.entries(report.capability_vector)) {
    lines.push(`  ${k}: ${v}`);
  }
  lines.push("observed_vector (observed_result):");
  for (const [k, v] of Object.entries(report.observed_vector)) {
    lines.push(`  ${k}: ${v}`);
  }
  lines.push("claim_status_vector:");
  for (const [k, v] of Object.entries(report.claim_status_vector)) {
    lines.push(`  ${k}: ${v}`);
  }
  if (report.unknown_claims.length > 0) {
    lines.push(
      `warning: unknown_claims (not in KNOWN_INVARIANTS or INVARIANT_PARENTS): ${JSON.stringify(report.unknown_claims)}`,
    );
  }
  lines.push("findings:");
  for (const f of report.findings) {
    lines.push(
      `- ${f.invariant}: result=${f.result} observed_result=${f.observed_result} claim_status=${f.claim_status}`,
    );
    if (f.witness_seqs.length) {
      lines.push(`  witness_seqs: [${f.witness_seqs.join(", ")}]`);
    }
    lines.push(`  explanation: ${f.explanation}`);
  }
  lines.push("");
  lines.push(
    "note: result=not_tested means checker not run; claim_status=not_declared means profile does not claim — these are distinct fields and must not be conflated. observed_result is the raw checker conclusion; result may be claim-rewritten.",
  );
  return lines.join("\n");
}
