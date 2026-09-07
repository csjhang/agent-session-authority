import type { Checker } from "./index.js";
import { attrs, basis, claim_for, finding, str, observation_guard } from "./index.js";

/** AUTH-05 — approval is not control; control is not blanket approval */
export const check_auth05: Checker = (ctx) => {
  const inv = "AUTH-05";
  const cs = claim_for(ctx, inv);
  const guard = observation_guard(ctx, inv, ctx.events.some((e) => e.op === "approval.grant") && ctx.events.some((e) => e.op === "effect.dispatch"), ctx.events.some((e) => e.op === "effect.receipt" || e.op === "effect.dispatch"));
  if (guard) return guard;
  const controllers = new Set<string>();
  const controller_roles = new Set<string>();
  const approvers = new Set<string>();
  const approval_seq = new Map<string, number>();

  for (const ev of ctx.events) {
    const a = attrs(ev);
    if (ev.op === "lease.acquire" && (ev.kind === "ok" || (ev.kind === "info" && a.accepted === true))) {
      const holder = str(a.holder) ?? ev.actor_id;
      if (holder) {
        controllers.add(holder);
        if (str(a.role) === "controller" || a.control_role === "controller" || a.independent_control === true) controller_roles.add(holder);
        const prior_grant = approval_seq.get(holder);
        if (prior_grant != null && str(a.role) === "approver" && !controller_roles.has(holder)) {
          return [finding(inv, cs, "violation", "Approver " + holder + " acquired ControlLease after granting approval without an independent controller role.", [prior_grant, ev.seq], basis(ctx))];
        }
      }
    }
    if ((ev.op === "lease.release" || ev.op === "lease.revoke") && (ev.kind === "ok" || ev.kind === "info")) {
      const holder = str(a.holder) ?? ev.actor_id;
      if (holder) controllers.delete(holder);
    }
    if (ev.op === "approval.grant" && (ev.kind === "ok" || ev.kind === "info")) {
      const approver = str(a.approver) ?? ev.actor_id;
      if (approver) { approvers.add(approver); approval_seq.set(approver, ev.seq); }
      if (a.auto_from_control === true) {
        return [finding(inv, cs, "violation",
          "Control lease used as implicit blanket approval (auto_from_control).",
          [ev.seq], basis(ctx))];
      }
    }
    if (ev.op === "effect.dispatch" && (ev.kind === "ok" || ev.kind === "invoke" || ev.kind === "info")) {
      const actor = ev.actor_id ?? str(a.actor_id);
      const role = str(a.role);
      if (role === "approver" && actor && !controllers.has(actor)) {
        if (a.used_approval_as_control === true || (approvers.has(actor) && !controllers.has(actor))) {
          return [finding(inv, cs, "violation",
            `Approver ${actor} dispatched effect using approval as control without ControlLease.`,
            [ev.seq], basis(ctx))];
        }
      }
    }
    if (ev.op === "lease.acquire" && (ev.kind === "ok" || (ev.kind === "info" && a.accepted === true))) {
      if (a.granted_because_approver === true) {
        return [finding(inv, cs, "violation",
          "ControlLease granted solely because actor is Approver.",
          [ev.seq], basis(ctx))];
      }
    }
  }
  const evidence_guard = observation_guard(ctx, inv, true,
    ctx.events.some((e) => e.op === "approval.grant" && str(attrs(e).approver) != null && str(attrs(e).role) != null && str(attrs(e).policy) != null) &&
    ctx.events.some((e) => e.op === "lease.acquire" && attrs(e).accepted === true && str(attrs(e).holder) != null && str(attrs(e).role) != null && str(attrs(e).policy) != null && Array.isArray(attrs(e).permissions)) &&
    ctx.events.some((e) => e.op === "effect.dispatch" && str(attrs(e).role) != null && str(attrs(e).policy) != null));
  if (evidence_guard) return evidence_guard;
  return [finding(inv, cs, "supported",
    "No conflation of approval and control observed.", [], basis(ctx))];
};
