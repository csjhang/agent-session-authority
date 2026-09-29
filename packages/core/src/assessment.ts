import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validate_json } from "./schema.js";

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
  /** Claim-rewritten grade (may differ from observed_result). */
  result: ResultLabel;
  /** Checker's raw conclusion before claim rewrite; always filled honestly. */
  observed_result: ResultLabel;
  witness_seqs: number[];
  explanation: string;
  reproducible: boolean;
  test_basis: TestBasis;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const ASSESSMENT_SCHEMA_PATH = path.resolve(
  here,
  "../../../spec/authority-assessment.schema.json",
);

let _assessment_schema: unknown | undefined;
function assessment_schema(): unknown {
  if (_assessment_schema === undefined) {
    _assessment_schema = JSON.parse(fs.readFileSync(ASSESSMENT_SCHEMA_PATH, "utf8"));
  }
  return _assessment_schema;
}

/**
 * undefined path → null; path given but missing → throw; JSON fail → throw with path;
 * schema fail → throw listing all errors.
 */
export function load_assessment(file_path: string | undefined): AuthorityAssessment | null {
  if (file_path === undefined) return null;
  if (!fs.existsSync(file_path)) {
    throw new Error(`assessment file not found: ${file_path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file_path, "utf8"));
  } catch (err) {
    throw new Error(`assessment JSON parse failed for ${file_path}: ${String(err)}`);
  }
  const errors = validate_json(assessment_schema(), raw);
  if (errors.length > 0) {
    throw new Error(
      `assessment schema validation failed for ${file_path}:\n${errors.join("\n")}`,
    );
  }
  return raw as AuthorityAssessment;
}

export function default_assessment(): AuthorityAssessment {
  return {
    target: "synthetic",
    profile_version: "0.2",
    claims_file: null,
    test_basis: "synthetic_fixture",
  };
}
