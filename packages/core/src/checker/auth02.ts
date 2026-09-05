import type { Checker } from "./index.js";
import { finding, basis, claim_for } from "./index.js";
export const check_auth02: Checker = (ctx) => {
  const inv = "AUTH-02";
  return [finding(inv, claim_for(ctx, inv), "not_tested", "AUTH-02 checker deferred to week 2.", [], basis(ctx))];
};
