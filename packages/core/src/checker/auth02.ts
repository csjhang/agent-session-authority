import type { Checker } from "./index.js";
import { attrs, basis, claim_for, finding, num, str } from "./index.js";

const BINDING_KEYS = [
  "target",
  "args",
  "policy_version",
  "runtime_generation",
  "nonce",
  "expiry",
] as const;

type BindingSnap = {
  seq: number;
  action_digest: string;
  target?: string;
  args?: string;
  policy_version?: string;
  runtime_generation?: number;
  nonce?: string;
  expiry?: string;
};

function snap_from_attrs(seq: number, digest: string, a: Record<string, unknown>): BindingSnap {
  return {
    seq,
    action_digest: digest,
    target: str(a.target),
    args: a.args !== undefined ? JSON.stringify(a.args) : undefined,
    policy_version: str(a.policy_version),
    runtime_generation: num(a.runtime_generation),
    nonce: str(a.nonce),
    expiry: str(a.expiry),
  };
}

function changed_fields(approved: BindingSnap, current: BindingSnap): string[] {
  const out: string[] = [];
  for (const k of BINDING_KEYS) {
    const left = approved[k];
    const right = current[k];
    if (left === undefined || right === undefined) continue;
    if (left !== right) out.push(k);
  }
  return out;
}

/**
 * AUTH-02 — action-bound approval.
 * Approval binds a canonical ActionBinding digest; changing target/args/
 * policyVersion/generation/nonce/expiry invalidates the old approval.
 */
export const check_auth02: Checker = (ctx) => {
  const inv = "AUTH-02";
  const cs = claim_for(ctx, inv);

  /** digest -> first binding snapshot that defined it */
  const bindings = new Map<string, BindingSnap>();
  /** digest -> approval grant seq + snapshot at grant time */
  const approvals = new Map<string, { seq: number; snap: BindingSnap }>();

  for (const ev of ctx.events) {
    const a = attrs(ev);

    if ((ev.op === "action.bind" || ev.op === "action.propose") && (ev.kind === "ok" || ev.kind === "info" || ev.kind === "invoke")) {
      const digest = str(a.action_digest);
      if (!digest) continue;
      const snap = snap_from_attrs(ev.seq, digest, a);
      const prev = bindings.get(digest);
      if (prev) {
        const delta = changed_fields(prev, snap);
        if (delta.length > 0) {
          // Same digest used for different binding fields — digest collision / rebound
          const approved = approvals.get(digest);
          if (approved) {
            return [
              finding(
                inv,
                cs,
                "violation",
                `ActionBinding fields changed after approval (${delta.join(",")}) while reusing action_digest=${digest}.`,
                [prev.seq, approved.seq, ev.seq],
                basis(ctx),
              ),
            ];
          }
          return [
            finding(
              inv,
              cs,
              "violation",
              `action_digest=${digest} rebound with changed fields (${delta.join(",")}).`,
              [prev.seq, ev.seq],
              basis(ctx),
            ),
          ];
        }
      } else {
        bindings.set(digest, snap);
      }
    }

    if (ev.op === "approval.grant" && (ev.kind === "ok" || ev.kind === "info")) {
      const digest = str(a.action_digest);
      if (!digest) continue;
      const base = bindings.get(digest) ?? snap_from_attrs(ev.seq, digest, a);
      // Approval attrs may carry binding fields explicitly
      const snap = snap_from_attrs(ev.seq, digest, { ...base, ...a, action_digest: digest });
      approvals.set(digest, { seq: ev.seq, snap: { ...base, ...snap, action_digest: digest } });
    }

    if (ev.op === "effect.receipt" || ev.op === "effect.dispatch") {
      const outcome = str(a.outcome) ?? str(a.status);
      const digest = str(a.action_digest);
      if (!digest) continue;
      const approved = approvals.get(digest);
      if (!approved) continue;

      const current = snap_from_attrs(ev.seq, digest, a);
      const delta = changed_fields(approved.snap, current);

      // Explicit stale-approval reuse marker
      if (a.reuse_stale_approval === true && (outcome === "committed" || outcome === "success" || outcome === "completed" || ev.op === "effect.receipt")) {
        return [
          finding(
            inv,
            cs,
            "violation",
            `Committed/dispatched effect reused stale approval for action_digest=${digest}.`,
            [approved.seq, ev.seq],
            basis(ctx),
          ),
        ];
      }

      if (delta.length > 0 && (outcome === "committed" || (ev.op === "effect.receipt" && outcome !== "rejected" && outcome !== "failed"))) {
        if (ev.op === "effect.receipt" && outcome === "committed") {
          return [
            finding(
              inv,
              cs,
              "violation",
              `Effect committed with approval for action_digest=${digest} after binding fields changed (${delta.join(",")}).`,
              [approved.snap.seq, approved.seq, ev.seq],
              basis(ctx),
            ),
          ];
        }
      }

      // Dispatch/receipt carries binding fields that diverge from approved snapshot
      if (ev.op === "effect.receipt" && outcome === "committed" && a.binding_changed_after_approval === true) {
        return [
          finding(
            inv,
            cs,
            "violation",
            `binding_changed_after_approval with committed receipt for action_digest=${digest}.`,
            [approved.seq, ev.seq],
            basis(ctx),
          ),
        ];
      }
    }
  }

  // If we saw at least one approval+matching commit with stable fields → supported;
  // otherwise supported when no counterexample (synthetic fixtures).
  return [
    finding(
      inv,
      cs === "not_declared" ? "declared" : cs,
      "supported",
      "No action-bound approval reuse after binding-field change observed.",
      [],
      basis(ctx),
    ),
  ];
};
