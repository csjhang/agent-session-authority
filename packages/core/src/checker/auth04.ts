import type { Checker } from "./index.js";
import { finding, basis, claim_for } from "./index.js";
export const check_auth04: Checker = (ctx) => {
  const inv = "AUTH-04";
  return [finding(inv, claim_for(ctx, inv), "not_tested", "AUTH-04 checker deferred to week 2.", [], basis(ctx))];
};
