import type { HistoryEvent } from "./history.js";
import type { AuthorityProfile } from "./declaration.js";
import type { AuthorityAssessment, CheckFinding } from "./assessment.js";
import type { Checker, CheckerContext } from "./checker/index.js";
import { check_auth01 } from "./checker/auth01.js";
import { check_auth02 } from "./checker/auth02.js";
import { check_auth03 } from "./checker/auth03.js";
import { check_auth04 } from "./checker/auth04.js";
import { check_auth05 } from "./checker/auth05.js";
import { check_auth06 } from "./checker/auth06.js";
import { check_auth07 } from "./checker/auth07.js";
import { check_auth08 } from "./checker/auth08.js";

const CHECKERS: Checker[] = [
  check_auth01,
  check_auth02,
  check_auth03,
  check_auth04,
  check_auth05,
  check_auth06,
  check_auth07,
  check_auth08,
];

export interface RunCheckersOptions {
  auth08_disclosures?: import("./auth08_disclosures.js").Auth08Disclosures;
}

export function run_checkers(
  events: HistoryEvent[],
  profile: AuthorityProfile | null,
  assessment: AuthorityAssessment,
  options?: RunCheckersOptions,
): CheckFinding[] {
  const ctx: CheckerContext = {
    events,
    profile,
    assessment,
    auth08_disclosures: options?.auth08_disclosures,
  };
  const out: CheckFinding[] = [];
  for (const check of CHECKERS) out.push(...check(ctx));
  return out;
}

export * from "./history.js";
export * from "./auth08_disclosures.js";
export * from "./declaration.js";
export * from "./assessment.js";
export * from "./report.js";
export { validate_json } from "./schema.js";
export { canonicalize } from "./jcs.js";
export { action_digest } from "./action_digest.js";
export {
  claim_for,
  finding,
  KNOWN_INVARIANTS,
  INVARIANT_PARENTS,
} from "./checker/index.js";
export {
  check_auth08,
  examine_committed_receipts,
  count_never_asked,
  count_unmappable,
  count_asked,
  AUTH08_NT_SETUP,
} from "./checker/auth08.js";
