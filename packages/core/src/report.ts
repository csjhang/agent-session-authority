import type { AuthorityAssessment, CheckFinding, ResultLabel } from "./assessment.js";
import type { AuthorityProfile, ClaimStatus } from "./declaration.js";

/**
 * Capability vector uses `result` only.
 * `claim_status` is a separate axis — never conflate:
 *   - result=not_tested  → checker not implemented / not run
 *   - claim_status=not_declared → profile does not claim the invariant
 * A finding may be result=not_tested AND claim_status=not_declared simultaneously.
 */
export interface CapabilityVectorReport {
  target: string;
  profile_version: string;
  test_basis: string;
  findings: CheckFinding[];
  /** Per-invariant checker result (includes not_tested). */
  capability_vector: Record<string, ResultLabel>;
  /** Per-invariant declaration status from the profile (includes not_declared). */
  claim_status_vector: Record<string, ClaimStatus>;
}

export function build_report(
  findings: CheckFinding[],
  assessment: AuthorityAssessment,
  _profile: AuthorityProfile | null,
): CapabilityVectorReport {
  const capability_vector: Record<string, ResultLabel> = {};
  const claim_status_vector: Record<string, ClaimStatus> = {};
  for (const f of findings) {
    capability_vector[f.invariant] = f.result;
    claim_status_vector[f.invariant] = f.claim_status;
  }
  return {
    target: assessment.target ?? "unknown",
    profile_version: assessment.profile_version ?? "0.2",
    test_basis: assessment.test_basis ?? "synthetic_fixture",
    findings,
    capability_vector,
    claim_status_vector,
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
  lines.push("claim_status_vector:");
  for (const [k, v] of Object.entries(report.claim_status_vector)) {
    lines.push(`  ${k}: ${v}`);
  }
  lines.push("findings:");
  for (const f of report.findings) {
    lines.push(`- ${f.invariant}: result=${f.result} claim_status=${f.claim_status}`);
    if (f.witness_seqs.length) {
      lines.push(`  witness_seqs: [${f.witness_seqs.join(", ")}]`);
    }
    lines.push(`  explanation: ${f.explanation}`);
  }
  lines.push("");
  lines.push(
    "note: result=not_tested means checker not run; claim_status=not_declared means profile does not claim — these are distinct fields and must not be conflated.",
  );
  return lines.join("\n");
}
