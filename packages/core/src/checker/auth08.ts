import type { Checker } from "./index.js";
import { basis, claim_for, finding } from "./index.js";

/**
 * AUTH-08 (Bypass honesty): no checker yet. Always not_tested.
 * Disclosure belongs in profile.known_bypasses and profile.coverage_boundary.
 */
export const check_auth08: Checker = (ctx) => {
  const cs = claim_for(ctx, "AUTH-08");
  return [
    finding(
      "AUTH-08",
      cs,
      "not_tested",
      "AUTH-08 (Bypass honesty) has no checker yet. Disclosure belongs in profile.known_bypasses and profile.coverage_boundary.",
      [],
      basis(ctx),
    ),
  ];
};
