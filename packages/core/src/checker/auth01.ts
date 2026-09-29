import type { Checker } from "./index.js";
import { attrs, basis, claim_for, finding, join_unique_sentences, num, str, observation_guard } from "./index.js";

function uniq_sort(seqs: number[]): number[] {
  return [...new Set(seqs)].sort((a, b) => a - b);
}

function is_restart_class(fault: string | undefined): boolean {
  return fault === "runtime.restart" || fault === "runtime.crash" || fault === "state.restore";
}

function observe_generation(ev: { kind: string; op?: string; attrs?: Record<string, unknown> }): number | undefined {
  if (!(ev.kind === "observe" && ev.op === "generation.observe")) return undefined;
  const a = attrs(ev);
  return num(a.runtime_generation) ?? num(a.generation);
}

/** AUTH-01a — declare generation model G0/G1/G2 (profile-only; no event witnesses) */
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
  return [
    finding(
      inv,
      cs,
      "supported",
      `Declared generation_model=${model} (based on profile).`,
      [],
      basis(ctx),
    ),
  ];
};

function generation_derived_note(ctx: Parameters<Checker>[0]): string {
  for (const ev of ctx.events) {
    if (!(ev.kind === "observe" && ev.op === "generation.observe")) continue;
    const a = attrs(ev);
    const fp = (a.field_provenance as Record<string, unknown> | undefined) ?? {};
    const issuer = str(a.issuer_id) ?? "";
    if (fp.runtime_generation === "derived" || issuer.endsWith("_adapter_")) {
      return " Note: generation derived by probe, not target-native.";
    }
  }
  return "";
}

/** AUTH-01b — monotonic RuntimeGeneration across restart/crash/restore */
export const check_auth01b: Checker = (ctx) => {
  const inv = "AUTH-01b";
  const cs = claim_for(ctx, inv);
  const guard = observation_guard(
    ctx,
    inv,
    ctx.events.some((e) => e.op === "generation.observe"),
    ctx.events.some((e) => e.op === "generation.observe"),
  );
  if (guard) return guard;
  const events = ctx.events;
  let last_gen: number | undefined;
  let last_gen_seq: number | undefined;
  const violations: { text: string; witnesses: number[] }[] = [];
  /** generation.observe + runtime.restart/crash/restore compared for this finding */
  const compared: number[] = [];

  for (const ev of events) {
    if (ev.kind === "observe" && ev.op === "generation.observe") {
      const g = num(attrs(ev).runtime_generation) ?? num(attrs(ev).generation);
      if (g == null) continue;
      compared.push(ev.seq);
      if (last_gen != null && g < last_gen) {
        violations.push({
          text: `RuntimeGeneration rolled back from ${last_gen} to ${g}.`,
          witnesses: [last_gen_seq!, ev.seq],
        });
      }
      last_gen = g;
      last_gen_seq = ev.seq;
    }
  }

  for (let i = 0; i < events.length; i++) {
    const fault = events[i]!;
    if (fault.kind !== "fault") continue;
    if (!is_restart_class(fault.fault)) continue;
    compared.push(fault.seq);
    const witnesses: number[] = [fault.seq];

    let gen_before: number | undefined;
    for (let j = i - 1; j >= 0; j--) {
      const e = events[j]!;
      if (e.kind === "observe" && e.op === "generation.observe") {
        gen_before = num(attrs(e).runtime_generation) ?? num(attrs(e).generation);
        if (gen_before != null) {
          witnesses.push(e.seq);
          break;
        }
      }
    }

    let gen_after: number | undefined;
    let gen_after_seq: number | undefined;
    for (let j = i + 1; j < events.length; j++) {
      const e = events[j]!;
      if (e.kind === "observe" && e.op === "generation.observe") {
        gen_after = num(attrs(e).runtime_generation) ?? num(attrs(e).generation);
        gen_after_seq = e.seq;
        if (gen_after != null) witnesses.push(e.seq);
        break;
      }
    }

    if (gen_before != null && gen_after != null && gen_after <= gen_before) {
      let committed_after = false;
      for (let j = 0; j < events.length; j++) {
        if (events[j]!.seq <= (gen_after_seq ?? fault.seq)) continue;
        const e = events[j]!;
        if (e.op === "effect.receipt" && (e.kind === "ok" || e.kind === "info" || e.kind === "observe")) {
          const outcome = str(attrs(e).outcome);
          const receipt_gen = num(attrs(e).runtime_generation);
          if (outcome === "committed" && (receipt_gen == null || receipt_gen <= gen_before)) {
            witnesses.push(e.seq);
            committed_after = true;
            violations.push({
              text: `After ${fault.fault}, RuntimeGeneration did not increase (${gen_before} -> ${gen_after}) and prior-gen effect committed.`,
              witnesses: uniq_sort(witnesses),
            });
            break;
          }
        }
      }
      if (!committed_after) {
        violations.push({
          text: `After ${fault.fault}, RuntimeGeneration did not strictly increase (${gen_before} -> ${gen_after}).`,
          witnesses: uniq_sort(witnesses),
        });
      }
    }
  }

  if (violations.length > 0) {
    const witnesses = uniq_sort(violations.flatMap((v) => v.witnesses));
    return [
      finding(inv, cs, "violation", join_unique_sentences(violations.map((v) => v.text)), witnesses, basis(ctx)),
    ];
  }

  // A restart-class event is examined only if generation.observe with generation
  // values exists BOTH before and after it.
  const restart_idxs: number[] = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.kind === "fault" && is_restart_class(ev.fault)) restart_idxs.push(i);
  }

  if (restart_idxs.length === 0) {
    return [
      finding(
        inv,
        cs,
        "inconclusive",
        "no restart observed, cross-restart increment not examined",
        [],
        basis(ctx),
      ),
    ];
  }

  const unexamined: number[] = [];
  for (const i of restart_idxs) {
    const fault = events[i]!;
    let before = false;
    for (let j = i - 1; j >= 0; j--) {
      if (observe_generation(events[j]!) != null) {
        before = true;
        break;
      }
    }
    let after = false;
    for (let j = i + 1; j < events.length; j++) {
      if (observe_generation(events[j]!) != null) {
        after = true;
        break;
      }
    }
    if (!(before && after)) unexamined.push(fault.seq);
  }

  if (unexamined.length > 0) {
    return [
      finding(
        inv,
        cs,
        "inconclusive",
        "unexamined restart-class event(s): cross-restart increment not examined",
        uniq_sort(unexamined),
        basis(ctx),
      ),
    ];
  }

  const derived = generation_derived_note(ctx);
  return [
    finding(
      inv,
      cs,
      "supported",
      "No generation monotonicity violation observed." + derived,
      uniq_sort(compared),
      basis(ctx),
    ),
  ];
};

/** AUTH-01c — G1+ issuer separation from fenced object */
export const check_auth01c: Checker = (ctx) => {
  const inv = "AUTH-01c";
  const cs = claim_for(ctx, inv);
  const model = ctx.profile?.generation_model;

  // 1. empty history → not_tested
  if (ctx.events.length === 0) {
    return [finding(inv, cs, "not_tested", "Scenario did not run: history is empty.", [], basis(ctx))];
  }

  // 2. generation_model G0 → supported (profile-based)
  if (model === "G0") {
    return [
      finding(
        inv,
        cs,
        "supported",
        "G0 self-issued model; issuer separation not required (based on profile).",
        [],
        basis(ctx),
      ),
    ];
  }

  // 3. no generation_model (incl. no profile) → observed_result not_declared
  if (model == null) {
    return [
      finding(
        inv,
        cs,
        "not_declared",
        "No profile/generation_model to evaluate issuer separation.",
        [],
        basis(ctx),
      ),
    ];
  }

  // 4. other generation_model → underspecified
  if (model !== "G1" && model !== "G2") {
    return [
      finding(
        inv,
        "underspecified",
        "underspecified",
        "generation_model missing or not G1/G2.",
        [],
        basis(ctx),
      ),
    ];
  }

  // 5. G1/G2 but no generation.observe → inconclusive
  const has_observe = ctx.events.some((e) => e.op === "generation.observe");
  if (!has_observe) {
    return [
      finding(
        inv,
        cs,
        "inconclusive",
        "Not enough observations for a positive conclusion.",
        [],
        basis(ctx),
      ),
    ];
  }

  // 6. else → issuer vs fenced object compare
  const violations: { text: string; witnesses: number[] }[] = [];
  const compared: number[] = [];
  for (const ev of ctx.events) {
    if (ev.kind === "observe" && ev.op === "generation.observe") {
      compared.push(ev.seq);
      const issuer = str(attrs(ev).issuer_id);
      const runtime = str(attrs(ev).runtime_id) ?? str(attrs(ev).fenced_object_id);
      if (issuer && runtime && issuer === runtime) {
        violations.push({ text: `Issuer ${issuer} equals fenced runtime object.`, witnesses: [ev.seq] });
      }
    }
  }
  if (violations.length > 0) {
    const witnesses = uniq_sort(violations.flatMap((v) => v.witnesses));
    return [
      finding(inv, cs, "violation", join_unique_sentences(violations.map((v) => v.text)), witnesses, basis(ctx)),
    ];
  }
  return [
    finding(
      inv,
      cs,
      "supported",
      "No issuer==fenced-object collision observed for G1+.",
      uniq_sort(compared),
      basis(ctx),
    ),
  ];
};

export const check_auth01: Checker = (ctx) => [
  ...check_auth01a(ctx),
  ...check_auth01b(ctx),
  ...check_auth01c(ctx),
];
