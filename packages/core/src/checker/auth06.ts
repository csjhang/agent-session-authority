import type { Checker } from "./index.js";
import { attrs, basis, claim_for, finding, str } from "./index.js";

/** AUTH-06 — no implicit success without trusted EffectReceipt */
export const check_auth06: Checker = (ctx) => {
  const inv = "AUTH-06";
  const cs = claim_for(ctx, inv);
  const guard = observation_guard(ctx, inv, ctx.events.some((e) => e.op === "effect.dispatch" || e.op === "effect.query"), ctx.events.some((e) => e.op === "effect.receipt"));
  if (guard) return guard;
  const receipts = new Set<string>();

  for (const ev of ctx.events) {
    const a = attrs(ev);
    if (ev.op === "effect.receipt") {
      const effect_id = str(a.effect_id);
      const outcome = str(a.outcome);
      if (effect_id && (outcome === "committed" || outcome === "rejected" || outcome === "failed" || outcome === "unknown")) {
        receipts.add(effect_id);
      }
      continue;
    }
    if (ev.op === "effect.dispatch" || ev.op === "effect.query") {
      const effect_id = str(a.effect_id);
      const status = str(a.status) ?? str(a.effect_status);
      if (status === "committed" || status === "success" || status === "completed") {
        if (!effect_id || !receipts.has(effect_id)) {
          if (ev.kind === "fail") continue;
          return [finding(inv, cs, "violation",
            `Effect marked ${status} without trusted EffectReceipt` + (effect_id ? ` for ${effect_id}` : "") + `. kind=${ev.kind} (fail!=info).`,
            [ev.seq], basis(ctx))];
        }
      }
    }
    if (str(a.effect_status) === "committed" || str(a.status) === "completed") {
      if (ev.op !== "effect.receipt") {
        const effect_id = str(a.effect_id);
        if (ev.kind === "fail") continue;
        if (!effect_id || !receipts.has(effect_id)) {
          return [finding(inv, cs, "violation",
            `Implicit success without EffectReceipt at seq=${ev.seq}.`,
            [ev.seq], basis(ctx))];
        }
      }
    }
  }
  return [finding(inv, cs, "supported",
    "No implicit success without EffectReceipt; fail!=info respected.", [], basis(ctx))];
};
