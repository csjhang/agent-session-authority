import type { Checker } from "./index.js";
import { attrs, basis, claim_for, finding, num, str } from "./index.js";

/**
 * AUTH-04 — fencing at effect boundary.
 * Stale controller / fence must fail at the effect gateway (receipt rejected),
 * not only in UI/relay.
 */
export const check_auth04: Checker = (ctx) => {
  const inv = "AUTH-04";
  const cs = claim_for(ctx, inv);

  /** scope_id -> latest valid fence_epoch */
  const live_fence = new Map<string, { epoch: number; seq: number; holder?: string }>();
  let global_epoch: { epoch: number; seq: number } | undefined;

  const bump = (scope_id: string | undefined, epoch: number, seq: number, holder?: string) => {
    if (scope_id) {
      const cur = live_fence.get(scope_id);
      if (!cur || epoch >= cur.epoch) live_fence.set(scope_id, { epoch, seq, holder });
    }
    if (!global_epoch || epoch >= global_epoch.epoch) global_epoch = { epoch, seq };
  };

  for (const ev of ctx.events) {
    const a = attrs(ev);

    if (ev.op === "lease.acquire" && (ev.kind === "ok" || (ev.kind === "info" && a.accepted === true))) {
      const epoch = num(a.fence_epoch);
      const scope_id = str(a.scope_id);
      const holder = str(a.holder) ?? ev.actor_id;
      if (epoch != null) bump(scope_id, epoch, ev.seq, holder);
    }

    if (ev.op === "control.handoff" && (ev.kind === "ok" || ev.kind === "info")) {
      const epoch = num(a.fence_epoch) ?? num(a.new_fence_epoch);
      const scope_id = str(a.scope_id);
      const holder = str(a.holder) ?? str(a.successor) ?? ev.actor_id;
      if (epoch != null) bump(scope_id, epoch, ev.seq, holder ?? undefined);
    }

    if ((ev.op === "lease.revoke" || ev.op === "lease.release") && (ev.kind === "ok" || ev.kind === "info")) {
      const epoch = num(a.fence_epoch);
      const scope_id = str(a.scope_id);
      // Revoke may raise epoch
      const raised = num(a.new_fence_epoch);
      if (raised != null) bump(scope_id, raised, ev.seq);
      else if (epoch != null && scope_id) {
        // mark that this epoch is no longer valid by bumping past it if noted
        if (a.stale === true || a.invalidate_fence === true) {
          bump(scope_id, epoch + 1, ev.seq);
        }
      }
    }

    if (ev.op === "effect.receipt") {
      const outcome = str(a.outcome);
      const fence_epoch = num(a.fence_epoch);
      const scope_id = str(a.scope_id) ?? "default";
      const live = live_fence.get(scope_id) ?? global_epoch;

      if (a.stale_fence === true || a.stale_controller === true) {
        if (outcome === "committed") {
          return [
            finding(
              inv,
              cs,
              "violation",
              "Stale fence/controller effect committed at gateway (UI/relay-only reject is insufficient).",
              [live?.seq, ev.seq].filter((x): x is number => typeof x === "number"),
              basis(ctx),
            ),
          ];
        }
        // rejected/failed at gateway is the compliant path
        continue;
      }

      if (outcome === "committed" && fence_epoch != null && live && fence_epoch < live.epoch) {
        return [
          finding(
            inv,
            cs,
            "violation",
            `Committed effect used stale fence_epoch=${fence_epoch} < live ${live.epoch} at effect boundary.`,
            [live.seq, ev.seq],
            basis(ctx),
          ),
        ];
      }
    }

    if (ev.op === "effect.dispatch") {
      const fence_epoch = num(a.fence_epoch);
      const scope_id = str(a.scope_id) ?? "default";
      const live = live_fence.get(scope_id) ?? global_epoch;
      if ((a.stale_fence === true || a.stale_controller === true) && (ev.kind === "ok" || str(a.status) === "committed")) {
        // dispatch ok with stale fence without later reject is suspicious; wait for receipt unless marked accepted_at_gateway
        if (a.accepted_at_gateway === true) {
          return [
            finding(
              inv,
              cs,
              "violation",
              "Stale controller dispatch accepted at effect gateway.",
              [live?.seq, ev.seq].filter((x): x is number => typeof x === "number"),
              basis(ctx),
            ),
          ];
        }
      }
      if (ev.kind === "ok" && fence_epoch != null && live && fence_epoch < live.epoch && a.accepted_at_gateway === true) {
        return [
          finding(
            inv,
            cs,
            "violation",
            `Stale fence_epoch=${fence_epoch} accepted at gateway (live=${live.epoch}).`,
            [live.seq, ev.seq],
            basis(ctx),
          ),
        ];
      }
    }
  }

  return [
    finding(
      inv,
      cs === "not_declared" ? "declared" : cs,
      "supported",
      "No stale fence/controller commit at effect boundary observed.",
      [],
      basis(ctx),
    ),
  ];
};
