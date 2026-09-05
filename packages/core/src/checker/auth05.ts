import type { Checker } from "./index.js";
import { attrs, basis, claim_for, finding, str } from "./index.js";

/** AUTH-05 — approval is not control; control is not blanket approval */
export const check_auth05: Checker = (ctx) => {
  const inv = "AUTH-05";
  const cs = claim_for(ctx, inv);
  const controllers = new Set<string>();
  const approvers = new Set<string>();

  for (const ev of ctx.events) {
    const a = attrs(ev);
    if (ev.op === "lease.acquire" && (ev.kind === "ok" || ev.kind === "info")) {
      const holder = str(a.holder) ?? ev.actor_id;
      if (holder) controllers.add(holder);
    }
    if ((ev.op === "lease.release" || ev.op === "lease.revoke") && (ev.kind === "ok" || ev.kind === "info")) {
      const holder = str(a.holder) ?? ev.actor_id;
      if (holder) controllers.delete(holder);
    }
    if (ev.op === "approval.grant" && (ev.kind === "ok" || ev.kind === "info")) {
      const approver = str(a.approver) ?? ev.actor_id;
      if (approver) approvers.add(approver);
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
        if (a.used_approval_as_control === true) {
          return [finding(inv, cs, "violation",
            `Approver ${actor} dispatched effect using approval as control without ControlLease.`,
            [ev.seq], basis(ctx))];
        }
      }
    }
    if (ev.op === "lease.acquire" && (ev.kind === "ok" || ev.kind === "info")) {
      if (a.granted_because_approver === true) {
        return [finding(inv, cs, "violation",
          "ControlLease granted solely because actor is Approver.",
          [ev.seq], basis(ctx))];
      }
    }
  }
  return [finding(inv, cs === "not_declared" ? "declared" : cs, "supported",
    "No conflation of approval and control observed.", [], basis(ctx))];
};
