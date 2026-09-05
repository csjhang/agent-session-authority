import type { AuthorityAssessment, CheckFinding, ResultLabel } from "./assessment.js";
import type { AuthorityProfile } from "./declaration.js";

export interface CapabilityVectorReport {
  target: string;
  profile_version: string;
  test_basis: string;
  findings: CheckFinding[];
  capability_vector: Record<string, ResultLabel>;
}

export function build_report(
  findings: CheckFinding[],
  assessment: AuthorityAssessment,
  _profile: AuthorityProfile | null,
): CapabilityVectorReport {
  const capability_vector: Record<string, ResultLabel> = {};
  for (const f of findings) {
    capability_vector[f.invariant] = f.result;
  }
  return {
    target: assessment.target ?? "unknown",
    profile_version: assessment.profile_version ?? "0.2",
    test_basis: assessment.test_basis ?? "synthetic_fixture",
    findings,
    capability_vector,
  };
}

export function format_report(report: CapabilityVectorReport): string {
  const lines: string[] = [];
  lines.push(`target: ${report.target}`);
  lines.push(`profile_version: ${report.profile_version}`);
  lines.push(`test_basis: ${report.test_basis}`);
  lines.push("capability_vector:");
  for (const [k, v] of Object.entries(report.capability_vector)) {
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
  return lines.join("\n");
}
