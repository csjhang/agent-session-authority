import fs from "node:fs";
export type TestBasis = "vendor_claim" | "research_profile" | "synthetic_fixture";

export type ResultLabel =
  | "supported"
  | "not_declared"
  | "violation"
  | "inconclusive"
  | "underspecified"
  | "not_tested";

export interface AuthorityAssessment {
  target?: string;
  profile_version?: string;
  claims_file?: string | null;
  claim_sources?: string[];
  test_basis?: TestBasis;
  notes?: string;
  [key: string]: unknown;
}

export interface CheckFinding {
  invariant: string;
  claim_status: import("./declaration.js").ClaimStatus;
  result: ResultLabel;
  witness_seqs: number[];
  explanation: string;
  reproducible: boolean;
  test_basis: TestBasis;
}

export function load_assessment(path: string | undefined): AuthorityAssessment | null {
  if (!path) return null;
  if (!fs.existsSync(path)) return null;
  return JSON.parse(fs.readFileSync(path, "utf8")) as AuthorityAssessment;
}

export function default_assessment(): AuthorityAssessment {
  return {
    target: "synthetic",
    profile_version: "0.2",
    claims_file: null,
    test_basis: "synthetic_fixture",
  };
}
