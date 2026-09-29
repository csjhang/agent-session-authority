import type { Checker } from "./index.js";
import { attrs, basis, claim_for, finding, str, observation_guard } from "./index.js";

function uniq_sort(seqs: number[]): number[] {
  return [...new Set(seqs)].sort((a, b) => a - b);
}

/**
 * AUTH-06 — no implicit success without trusted EffectReceipt.
 * Only outcome=committed receipts may support later committed/completed/success
 * claims; unknown/rejected/failed may not.
 * Supported requires ≥1 outcome=committed receipt positively evaluated;
 * otherwise inconclusive "no committed receipt evaluated".
 */
export const check_auth06: Checker = (ctx) => {
  const inv = "AUTH-06";
  const cs = claim_for(ctx, inv);
  const has_effect_activity = ctx.events.some(
    (e) => e.op === "effect.dispatch" || e.op === "effect.query" || e.op === "effect.receipt",
  );
  const guard = observation_guard(ctx, inv, has_effect_activity, has_effect_activity);
  if (guard) return guard;

  /** effect_id -> only committed receipts count as supporting evidence */
  const committed_receipts = new Set<string>();
  const committed_receipt_seqs = new Map<string, number>();
  const violations: { text: string; witnesses: number[] }[] = [];
  let saw_committed_receipt = false;
  const support_witnesses: number[] = [];

  for (const ev of ctx.events) {
    const a = attrs(ev);
    let judged = false;
    if (ev.op === "effect.receipt") {
      const effect_id = str(a.effect_id);
      const outcome = str(a.outcome);
      if (effect_id && outcome === "committed") {
        committed_receipts.add(effect_id);
        committed_receipt_seqs.set(effect_id, ev.seq);
        saw_committed_receipt = true;
        support_witnesses.push(ev.seq);
      }
      // unknown/rejected/failed intentionally do NOT populate committed_receipts
      continue;
    }
    if (ev.op === "effect.dispatch" || ev.op === "effect.query") {
      const effect_id = str(a.effect_id);
      const status = str(a.status) ?? str(a.effect_status);
      if (status === "committed" || status === "success" || status === "completed") {
        judged = true;
        if (!effect_id || !committed_receipts.has(effect_id)) {
          if (ev.kind === "fail") continue;
          violations.push({
            text:
              `Effect marked ${status} without trusted committed EffectReceipt` +
              (effect_id ? ` for ${effect_id}` : "") +
              `. kind=${ev.kind} (fail!=info).`,
            witnesses: [ev.seq],
          });
        } else {
          // success-state backed by committed receipt
          support_witnesses.push(ev.seq);
          const rseq = committed_receipt_seqs.get(effect_id);
          if (rseq != null) support_witnesses.push(rseq);
        }
      }
    }
    if (!judged && (str(a.effect_status) === "committed" || str(a.status) === "completed")) {
      if (ev.op !== "effect.receipt") {
        const effect_id = str(a.effect_id);
        if (ev.kind === "fail") continue;
        if (!effect_id || !committed_receipts.has(effect_id)) {
          violations.push({
            text: `Implicit success without committed EffectReceipt at seq=${ev.seq}.`,
            witnesses: [ev.seq],
          });
        } else if (ev.op !== "effect.dispatch" && ev.op !== "effect.query") {
          support_witnesses.push(ev.seq);
          const rseq = committed_receipt_seqs.get(effect_id);
          if (rseq != null) support_witnesses.push(rseq);
        }
      }
    }
  }

  if (violations.length > 0) {
    const witnesses = [...new Set(violations.flatMap((v) => v.witnesses))].sort((a, b) => a - b);
    return [
      finding(inv, cs, "violation", violations.map((v) => v.text).join(" "), witnesses, basis(ctx)),
    ];
  }
  if (!saw_committed_receipt) {
    return [
      finding(
        inv,
        cs,
        "inconclusive",
        "no committed receipt evaluated",
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
      "No implicit success without committed EffectReceipt; fail!=info respected.",
      uniq_sort(support_witnesses),
      basis(ctx),
    ),
  ];
};
