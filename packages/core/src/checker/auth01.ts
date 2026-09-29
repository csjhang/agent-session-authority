import type { HistoryEvent } from "../history.js";
import type { Checker } from "./index.js";
import { attrs, basis, claim_for, finding, join_unique_sentences, num, str, observation_guard } from "./index.js";

function uniq_sort(seqs: number[]): number[] {
  return [...new Set(seqs)].sort((a, b) => a - b);
}

function is_restart_class(fault: string | undefined): boolean {
  return fault === "runtime.restart" || fault === "runtime.crash" || fault === "state.restore";
}

function observe_generation(ev: HistoryEvent): number | undefined {
  if (!(ev.kind === "observe" && ev.op === "generation.observe")) return undefined;
  const a = attrs(ev);
  return num(a.runtime_generation) ?? num(a.generation);
}

/** Stream key: `${runtime_id ?? ""}|${session_id ?? ""}` (empty ids share one stream). */
function stream_of(ev: HistoryEvent): string {
  const rid = str(attrs(ev).runtime_id) ?? "";
  const sid = ev.session_id ?? "";
  return `${rid}|${sid}`;
}

/** AUTH-01a — declare generation model G0/G1/G2 (profile-only; no event witnesses) */
export const check_auth01a: Checker = (ctx) => {
  const inv = "AUTH-01a";
  const cs = claim_for(ctx, inv);
  const model = ctx.profile?.generation_model;
  if (!ctx.profile || model == null) {
    if (cs === "declared") {
      return [
        finding(
          inv,
          cs,
          "underspecified",
          "AUTH-01a is claimed but the profile declares no generation_model.",
          [],
          basis(ctx),
        ),
      ];
    }
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

function observe_maps_to_restart(observe: HistoryEvent, restart: HistoryEvent): boolean {
  const r_rid = str(attrs(restart).runtime_id);
  const r_sid = restart.session_id;
  if (r_rid) return str(attrs(observe).runtime_id) === r_rid;
  if (r_sid) return observe.session_id === r_sid;
  return true;
}

/** AUTH-01b — monotonic RuntimeGeneration across restart/crash/restore (per generation stream) */
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
  const violations: { text: string; witnesses: number[] }[] = [];
  const compared: number[] = [];

  // Regression only within stream.
  const last_by_stream = new Map<string, { gen: number; seq: number }>();
  for (const ev of events) {
    if (!(ev.kind === "observe" && ev.op === "generation.observe")) continue;
    const g = observe_generation(ev);
    if (g == null) continue;
    const stream = stream_of(ev);
    compared.push(ev.seq);
    const prev = last_by_stream.get(stream);
    if (prev != null && g < prev.gen) {
      violations.push({
        text: `RuntimeGeneration rolled back from ${prev.gen} to ${g}.`,
        witnesses: [prev.seq, ev.seq],
      });
    }
    last_by_stream.set(stream, { gen: g, seq: ev.seq });
  }

  for (let i = 0; i < events.length; i++) {
    const fault = events[i]!;
    if (fault.kind !== "fault") continue;
    if (!is_restart_class(fault.fault)) continue;

    const mapped: HistoryEvent[] = [];
    for (const ev of events) {
      if (!(ev.kind === "observe" && ev.op === "generation.observe")) continue;
      if (observe_maps_to_restart(ev, fault)) mapped.push(ev);
    }

    const restart_has_neither = str(attrs(fault).runtime_id) == null && !fault.session_id;
    const mapped_streams = new Set<string>();
    for (const ev of mapped) {
      mapped_streams.add(stream_of(ev));
    }
    if (restart_has_neither && mapped_streams.size > 1) {
      // unexamined — handled below; still record restart for witness path
      continue;
    }

    // Per mapped stream (or a single anonymous stream when observes have no stream key)
    const streams: Array<string | null> =
      mapped_streams.size > 0 ? [...mapped_streams] : [null];
    for (const stream of streams) {
      let gen_before: number | undefined;
      let before_seq: number | undefined;
      for (let j = i - 1; j >= 0; j--) {
        const e = events[j]!;
        if (!(e.kind === "observe" && e.op === "generation.observe")) continue;
        if (!observe_maps_to_restart(e, fault)) continue;
        if (stream != null && stream_of(e) !== stream) continue;
        const g = observe_generation(e);
        if (g == null) continue;
        gen_before = g;
        before_seq = e.seq;
        break;
      }
      let gen_after: number | undefined;
      let after_seq: number | undefined;
      for (let j = i + 1; j < events.length; j++) {
        const e = events[j]!;
        if (!(e.kind === "observe" && e.op === "generation.observe")) continue;
        if (!observe_maps_to_restart(e, fault)) continue;
        if (stream != null && stream_of(e) !== stream) continue;
        const g = observe_generation(e);
        if (g == null) continue;
        gen_after = g;
        after_seq = e.seq;
        break;
      }
      if (gen_before != null && gen_after != null && gen_after <= gen_before) {
        const witnesses_base = uniq_sort(
          [fault.seq, before_seq!, after_seq!].filter((x): x is number => typeof x === "number"),
        );
        let committed_prior = false;
        for (let j = 0; j < events.length; j++) {
          if (events[j]!.seq <= (after_seq ?? fault.seq)) continue;
          const e = events[j]!;
          if (
            e.op === "effect.receipt" &&
            (e.kind === "ok" || e.kind === "info" || e.kind === "observe")
          ) {
            const outcome = str(attrs(e).outcome);
            const receipt_gen = num(attrs(e).runtime_generation);
            if (outcome === "committed" && (receipt_gen == null || receipt_gen <= gen_before)) {
              committed_prior = true;
              violations.push({
                text: `After ${fault.fault}, RuntimeGeneration did not increase (${gen_before} -> ${gen_after}) and prior-gen effect committed.`,
                witnesses: uniq_sort([...witnesses_base, e.seq]),
              });
              break;
            }
          }
        }
        if (!committed_prior) {
          violations.push({
            text: `After ${fault.fault}, RuntimeGeneration did not strictly increase (${gen_before} -> ${gen_after}).`,
            witnesses: witnesses_base,
          });
        }
      }
    }
  }

  if (violations.length > 0) {
    const witnesses = uniq_sort(violations.flatMap((v) => v.witnesses));
    return [
      finding(inv, cs, "violation", join_unique_sentences(violations.map((v) => v.text)), witnesses, basis(ctx)),
    ];
  }

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
  const examined_restart_seqs: number[] = [];
  for (const i of restart_idxs) {
    const fault = events[i]!;
    const mapped: HistoryEvent[] = [];
    for (const ev of events) {
      if (!(ev.kind === "observe" && ev.op === "generation.observe")) continue;
      if (observe_maps_to_restart(ev, fault)) mapped.push(ev);
    }
    const restart_has_neither = str(attrs(fault).runtime_id) == null && !fault.session_id;
    const mapped_streams = new Set<string>();
    for (const ev of mapped) {
      mapped_streams.add(stream_of(ev));
    }
    if (restart_has_neither && mapped_streams.size > 1) {
      unexamined.push(fault.seq);
      continue;
    }

    const streams = [...mapped_streams];
    let any_stream_examined = false;
    for (const stream of streams) {
      let before = false;
      let after = false;
      for (let j = i - 1; j >= 0; j--) {
        const e = events[j]!;
        if (!(e.kind === "observe" && e.op === "generation.observe")) continue;
        if (!observe_maps_to_restart(e, fault)) continue;
        if (stream_of(e) !== stream) continue;
        if (observe_generation(e) != null) {
          before = true;
          break;
        }
      }
      for (let j = i + 1; j < events.length; j++) {
        const e = events[j]!;
        if (!(e.kind === "observe" && e.op === "generation.observe")) continue;
        if (!observe_maps_to_restart(e, fault)) continue;
        if (stream_of(e) !== stream) continue;
        if (observe_generation(e) != null) {
          after = true;
          break;
        }
      }
      if (before && after) any_stream_examined = true;
    }
    // Also handle restart that maps to a single stream with no stream key on observes
    if (streams.length === 0) {
      let before = false;
      let after = false;
      for (let j = i - 1; j >= 0; j--) {
        const e = events[j]!;
        if (!observe_maps_to_restart(e, fault)) continue;
        if (observe_generation(e) != null) {
          before = true;
          break;
        }
      }
      for (let j = i + 1; j < events.length; j++) {
        const e = events[j]!;
        if (!observe_maps_to_restart(e, fault)) continue;
        if (observe_generation(e) != null) {
          after = true;
          break;
        }
      }
      if (before && after) any_stream_examined = true;
    }

    if (any_stream_examined) {
      examined_restart_seqs.push(fault.seq);
      compared.push(fault.seq);
      for (const ev of mapped) {
        if (observe_generation(ev) != null) compared.push(ev.seq);
      }
    } else {
      unexamined.push(fault.seq);
    }
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

  if (ctx.events.length === 0) {
    return [finding(inv, cs, "not_tested", "Scenario did not run: history is empty.", [], basis(ctx))];
  }

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

  const violations: { text: string; witnesses: number[] }[] = [];
  const examined: number[] = [];
  for (const ev of ctx.events) {
    if (!(ev.kind === "observe" && ev.op === "generation.observe")) continue;
    const issuer = str(attrs(ev).issuer_id);
    const runtime = str(attrs(ev).runtime_id) ?? str(attrs(ev).fenced_object_id);
    if (!(issuer && runtime)) continue;
    examined.push(ev.seq);
    if (issuer === runtime) {
      violations.push({ text: `Issuer ${issuer} equals fenced runtime object.`, witnesses: [ev.seq] });
    }
  }
  if (violations.length > 0) {
    const witnesses = uniq_sort(violations.flatMap((v) => v.witnesses));
    return [
      finding(inv, cs, "violation", join_unique_sentences(violations.map((v) => v.text)), witnesses, basis(ctx)),
    ];
  }
  if (examined.length === 0) {
    return [
      finding(
        inv,
        cs,
        "inconclusive",
        "no generation.observe carries both issuer_id and runtime_id/fenced_object_id; issuer separation not examined",
        [],
        basis(ctx),
      ),
    ];
  }
  return [
    finding(
      inv,
      cs,
      "supported",
      "No issuer==fenced-object collision observed for G1+.",
      uniq_sort(examined),
      basis(ctx),
    ),
  ];
};

export const check_auth01: Checker = (ctx) => [
  ...check_auth01a(ctx),
  ...check_auth01b(ctx),
  ...check_auth01c(ctx),
];
