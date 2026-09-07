import type { Checker } from "./index.js";
import { attrs, basis, claim_for, finding, num, str, observation_guard } from "./index.js";

/** AUTH-01a — declare generation model G0/G1/G2 */
export const check_auth01a: Checker = (ctx) => {
  const inv = "AUTH-01a";
  const cs = claim_for(ctx, inv);
  const model = ctx.profile?.generation_model;
  if (!ctx.profile || model == null) {
    return [finding(inv, "not_declared", "not_declared", "No generation_model declared in profile.", [], basis(ctx))];
  }
  if (model !== "G0" && model !== "G1" && model !== "G2") {
    return [finding(inv, "underspecified", "underspecified", `generation_model ${String(model)} is not G0/G1/G2.`, [], basis(ctx))];
  }
  return [finding(inv, cs, "supported", `Declared generation_model=${model}.`, [], basis(ctx))];
};

/** AUTH-01b — monotonic RuntimeGeneration across restart/crash/restore */
export const check_auth01b: Checker = (ctx) => {
  const inv = "AUTH-01b";
  const cs = claim_for(ctx, inv);
  const guard = observation_guard(ctx, inv, ctx.events.some((e) => e.op === "generation.observe"), ctx.events.some((e) => e.op === "generation.observe"));
  if (guard) return guard;
  const events = ctx.events;
  let last_gen: number | undefined;
  let last_gen_seq: number | undefined;
  const witnesses: number[] = [];

  for (const ev of events) {
    if (ev.kind === "observe" && ev.op === "generation.observe") {
      const g = num(attrs(ev).runtime_generation) ?? num(attrs(ev).generation);
      if (g == null) continue;
      if (last_gen != null && g < last_gen) {
        return [finding(inv, cs, "violation", `RuntimeGeneration rolled back from ${last_gen} to ${g}.`, [last_gen_seq!, ev.seq], basis(ctx))];
      }
      if (last_gen != null && g === last_gen) {
        // equality alone is ok until a restart/restore fault intervened
      }
      last_gen = g;
      last_gen_seq = ev.seq;
    }
  }

  // Look for restart/crash/restore then unchanged generation then committed receipt of prior-gen approval
  for (let i = 0; i < events.length; i++) {
    const fault = events[i]!;
    if (fault.kind !== "fault") continue;
    if (fault.fault !== "runtime.restart" && fault.fault !== "runtime.crash" && fault.fault !== "state.restore") continue;
    witnesses.length = 0;
    witnesses.push(fault.seq);

    let gen_before: number | undefined;
    for (let j = i - 1; j >= 0; j--) {
      const e = events[j]!;
      if (e.kind === "observe" && e.op === "generation.observe") {
        gen_before = num(attrs(e).runtime_generation) ?? num(attrs(e).generation);
        if (gen_before != null) { witnesses.push(e.seq); break; }
      }
    }

    let gen_after: number | undefined;
    let gen_after_seq: number | undefined;
    for (let j = i + 1; j < events.length; j++) {
      const e = events[j]!;
      if (e.kind === "observe" && e.op === "generation.observe") {
        gen_after = num(attrs(e).runtime_generation) ?? num(attrs(e).generation);
        gen_after_seq = e.seq;
        witnesses.push(e.seq);
        break;
      }
    }

    if (gen_before != null && gen_after != null && gen_after <= gen_before) {
      // stale approval effect committed after non-increasing generation
      for (let j = 0; j < events.length; j++) { if (events[j]!.seq <= (gen_after_seq ?? fault.seq)) continue;
        const e = events[j]!;
        if (e.op === "effect.receipt" && (e.kind === "ok" || e.kind === "info" || e.kind === "observe")) {
          const outcome = str(attrs(e).outcome);
          const receipt_gen = num(attrs(e).runtime_generation);
          if (outcome === "committed" && (receipt_gen == null || receipt_gen <= gen_before)) {
            witnesses.push(e.seq);
            return [finding(inv, cs, "violation",
              `After ${fault.fault}, RuntimeGeneration did not increase (${gen_before} -> ${gen_after}) and prior-gen effect committed.`,
              [...new Set(witnesses)].sort((a,b)=>a-b), basis(ctx))];
          }
        }
      }
      return [finding(inv, cs, "violation",
        `After ${fault.fault}, RuntimeGeneration did not strictly increase (${gen_before} -> ${gen_after}).`,
        [...new Set(witnesses)].sort((a,b)=>a-b), basis(ctx))];
    }
  }

  if (cs === "not_declared" && basis(ctx) !== "synthetic_fixture") {
    return [finding(inv, cs, "not_declared", "Invariant not declared by target profile.", [], basis(ctx))];
  }
  return [finding(inv, cs, "supported", "No generation monotonicity violation observed.", [], basis(ctx))];
};

/** AUTH-01c — G1+ issuer separation from fenced object */
export const check_auth01c: Checker = (ctx) => {
  const inv = "AUTH-01c";
  const cs = claim_for(ctx, inv);
  const guard = observation_guard(ctx, inv, ctx.profile?.generation_model === "G1" || ctx.profile?.generation_model === "G2", ctx.events.some((e) => e.op === "generation.observe"));
  if (guard) return guard;
  const model = ctx.profile?.generation_model;
  if (model === "G0") {
    return [finding(inv, cs, "supported", "G0 self-issued model; issuer separation not required.", [], basis(ctx))];
  }
  if (model !== "G1" && model !== "G2") {
    if (!ctx.profile) return [finding(inv, "not_declared", "not_declared", "No profile/generation_model to evaluate issuer separation.", [], basis(ctx))];
    return [finding(inv, "underspecified", "underspecified", "generation_model missing or not G1/G2.", [], basis(ctx))];
  }
  for (const ev of ctx.events) {
    if (ev.kind === "observe" && ev.op === "generation.observe") {
      const issuer = str(attrs(ev).issuer_id);
      const runtime = str(attrs(ev).runtime_id) ?? str(attrs(ev).fenced_object_id);
      if (issuer && runtime && issuer === runtime) {
        return [finding(inv, cs, "violation", `Issuer ${issuer} equals fenced runtime object.`, [ev.seq], basis(ctx))];
      }
    }
  }
  return [finding(inv, cs, "supported", "No issuer==fenced-object collision observed for G1+.", [], basis(ctx))];
};

export const check_auth01: Checker = (ctx) => [
  ...check_auth01a(ctx),
  ...check_auth01b(ctx),
  ...check_auth01c(ctx),
];
