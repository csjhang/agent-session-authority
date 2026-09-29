import type { Checker } from "./index.js";
import { attrs, basis, claim_for, finding, str, observation_guard } from "./index.js";

function uniq_sort(seqs: number[]): number[] {
  return [...new Set(seqs)].sort((a, b) => a - b);
}

/**
 * AUTH-05 — approval is not control; control is not blanket approval.
 * Do not rely on self-reported role; derive from whether the actor has granted
 * approval and/or currently holds a ControlLease.
 */
export const check_auth05: Checker = (ctx) => {
  const inv = "AUTH-05";
  const cs = claim_for(ctx, inv);
  const guard = observation_guard(
    ctx,
    inv,
    ctx.events.some((e) => e.op === "approval.grant") &&
      ctx.events.some((e) => e.op === "effect.dispatch" || e.op === "lease.acquire"),
    ctx.events.some((e) => e.op === "effect.receipt" || e.op === "effect.dispatch" || e.op === "lease.acquire"),
  );
  if (guard) return guard;

  const lease_holders = new Set<string>();
  const grantors = new Set<string>();
  const grant_seq = new Map<string, number>();
  /** Actors who held a lease before ever granting (independent controller). */
  const independent_controllers = new Set<string>();
  const violations: { text: string; witnesses: number[]; marker?: boolean }[] = [];
  const evaluated: number[] = [];

  for (const ev of ctx.events) {
    const a = attrs(ev);

    if (ev.op === "lease.acquire" && (ev.kind === "ok" || (ev.kind === "info" && a.accepted === true))) {
      const holder = str(a.holder) ?? ev.actor_id;
      if (!holder) continue;
      evaluated.push(ev.seq);

      if (a.granted_because_approver === true) {
        violations.push({
          text: "test-injected marker granted_because_approver: ControlLease granted solely because actor is Approver.",
          witnesses: [ev.seq],
          marker: true,
        });
      }

      const prior_grant = grant_seq.get(holder);
      if (prior_grant != null && !independent_controllers.has(holder)) {
        // Actor who previously granted approval then acquired control without
        // having been an independent controller — conflation.
        violations.push({
          text: `Approver ${holder} acquired ControlLease after granting approval without an independent controller role.`,
          witnesses: [prior_grant, ev.seq],
        });
      }

      if (!grantors.has(holder)) independent_controllers.add(holder);
      lease_holders.add(holder);
      continue;
    }

    if ((ev.op === "lease.release" || ev.op === "lease.revoke") && (ev.kind === "ok" || ev.kind === "info")) {
      const holder = str(a.holder) ?? ev.actor_id;
      if (holder) lease_holders.delete(holder);
      continue;
    }

    if (ev.op === "approval.grant" && (ev.kind === "ok" || ev.kind === "info")) {
      evaluated.push(ev.seq);
      const approver = str(a.approver) ?? ev.actor_id;
      if (approver) {
        grantors.add(approver);
        grant_seq.set(approver, ev.seq);
      }
      if (a.auto_from_control === true) {
        violations.push({
          text: "test-injected marker auto_from_control: Control lease used as implicit blanket approval.",
          witnesses: [ev.seq],
          marker: true,
        });
      }
      continue;
    }

    if (ev.op === "effect.dispatch" && (ev.kind === "ok" || ev.kind === "invoke" || ev.kind === "info")) {
      evaluated.push(ev.seq);
      const actor = ev.actor_id ?? str(a.actor_id);
      if (!actor) continue;

      if (a.used_approval_as_control === true) {
        violations.push({
          text: `test-injected marker used_approval_as_control: Approver ${actor} dispatched effect using approval as control.`,
          witnesses: [ev.seq],
          marker: true,
        });
      }

      // Derived: grantor dispatching without holding a lease
      if (grantors.has(actor) && !lease_holders.has(actor) && !independent_controllers.has(actor)) {
        violations.push({
          text: `Approver ${actor} dispatched effect using approval as control without ControlLease.`,
          witnesses: [grant_seq.get(actor)!, ev.seq].filter((x): x is number => typeof x === "number"),
        });
      }
    }
  }

  if (violations.length > 0) {
    const witnesses = [...new Set(violations.flatMap((v) => v.witnesses))].sort((a, b) => a - b);
    const marker_note = violations.some((v) => v.marker) ? " Includes test-injected marker." : "";
    return [
      finding(inv, cs, "violation", violations.map((v) => v.text).join(" ") + marker_note, witnesses, basis(ctx)),
    ];
  }

  const evidence_guard = observation_guard(
    ctx,
    inv,
    true,
    ctx.events.some((e) => e.op === "approval.grant" && str(attrs(e).approver) != null) &&
      ctx.events.some((e) => e.op === "lease.acquire" && attrs(e).accepted === true && str(attrs(e).holder) != null) &&
      ctx.events.some((e) => e.op === "effect.dispatch"),
  );
  if (evidence_guard) return evidence_guard;
  return [
    finding(inv, cs, "supported", "No conflation of approval and control observed.", uniq_sort(evaluated), basis(ctx)),
  ];
};
