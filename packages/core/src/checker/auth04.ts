import type { Checker } from "./index.js";
import { attrs, basis, claim_for, finding, num, str, observation_guard } from "./index.js";

function uniq_sort(seqs: number[]): number[] {
  return [...new Set(seqs)].sort((a, b) => a - b);
}

/**
 * AUTH-04 — fencing at effect boundary.
 * Stale controller / fence must fail at the effect gateway (receipt rejected),
 * not only in UI/relay.
 * After handoff, receipt/dispatch whose controller is not the current live holder
 * is a violation even when fence_epoch is unchanged.
 * Lower-epoch lease.acquire/handoff must not update the live holder (bump).
 * After handoff, committed receipt missing controller/holder/actor_id cannot
 * count as supported evidence.
 * Supported requires ≥1 outcome=committed receipt positively evaluated.
 */
export const check_auth04: Checker = (ctx) => {
  const inv = "AUTH-04";
  const cs = claim_for(ctx, inv);
  const guard = observation_guard(
    ctx,
    inv,
    ctx.events.some((e) => e.op === "lease.acquire" || e.op === "control.handoff"),
    ctx.events.some((e) => e.op === "effect.receipt" || e.op === "effect.dispatch"),
  );
  if (guard) return guard;

  /** scope_id -> latest valid fence_epoch + live holder */
  const live_fence = new Map<string, { epoch: number; seq: number; holder?: string }>();
  let global_epoch: { epoch: number; seq: number; holder?: string } | undefined;
  const violations: { text: string; witnesses: number[]; marker?: boolean }[] = [];
  let handoff_seen = false;
  let saw_positive_committed = false;
  const positive_witnesses: number[] = [];
  const missing_controller_witnesses: number[] = [];

  const bump = (scope_id: string | undefined, epoch: number, seq: number, holder?: string) => {
    if (scope_id) {
      const cur = live_fence.get(scope_id);
      if (!cur || epoch > cur.epoch) {
        live_fence.set(scope_id, { epoch, seq, holder: holder ?? cur?.holder });
      } else if (epoch === cur.epoch) {
        live_fence.set(scope_id, { epoch, seq, holder: holder ?? cur.holder });
      }
      // epoch < cur.epoch: lower-epoch must not update live holder
    }
    if (!global_epoch || epoch > global_epoch.epoch) {
      global_epoch = { epoch, seq, holder: holder ?? global_epoch?.holder };
    } else if (epoch === global_epoch.epoch) {
      global_epoch = { epoch, seq, holder: holder ?? global_epoch.holder };
    }
    // epoch < global: do not update
  };

  const set_holder = (scope_id: string | undefined, holder: string, seq: number) => {
    if (scope_id) {
      const cur = live_fence.get(scope_id);
      if (cur) live_fence.set(scope_id, { ...cur, holder, seq });
      else live_fence.set(scope_id, { epoch: global_epoch?.epoch ?? 0, seq, holder });
    }
    if (global_epoch) global_epoch = { ...global_epoch, holder, seq };
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
      handoff_seen = true;
      const epoch = num(a.fence_epoch) ?? num(a.new_fence_epoch);
      const scope_id = str(a.scope_id);
      const holder = str(a.to) ?? str(a.holder) ?? str(a.successor) ?? ev.actor_id;
      if (epoch != null) bump(scope_id, epoch, ev.seq, holder ?? undefined);
      else if (holder) set_holder(scope_id, holder, ev.seq);
    }

    if ((ev.op === "lease.revoke" || ev.op === "lease.release") && (ev.kind === "ok" || ev.kind === "info")) {
      const epoch = num(a.fence_epoch);
      const scope_id = str(a.scope_id);
      const raised = num(a.new_fence_epoch);
      if (raised != null) bump(scope_id, raised, ev.seq);
      else if (epoch != null && scope_id) {
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
      const controller = str(a.controller) ?? str(a.holder) ?? ev.actor_id;

      if (a.stale_fence === true || a.stale_controller === true) {
        if (outcome === "committed") {
          violations.push({
            text: "test-injected marker: Stale fence/controller effect committed at gateway (UI/relay-only reject is insufficient).",
            witnesses: [live?.seq, ev.seq].filter((x): x is number => typeof x === "number"),
            marker: true,
          });
        }
      }

      if (outcome === "committed" && fence_epoch != null && live && fence_epoch < live.epoch) {
        violations.push({
          text: `Committed effect used stale fence_epoch=${fence_epoch} < live ${live.epoch} at effect boundary.`,
          witnesses: [live.seq, ev.seq],
        });
      }

      // After handoff: missing controller/holder/actor_id cannot count as supported evidence
      if (outcome === "committed" && handoff_seen && !controller) {
        missing_controller_witnesses.push(ev.seq);
        continue;
      }

      // After handoff: controller must be current live holder even if epoch unchanged
      if (outcome === "committed" && controller && live?.holder && controller !== live.holder) {
        violations.push({
          text: `Committed effect controller=${controller} is not live holder=${live.holder} after handoff/lease (fence_epoch may be unchanged).`,
          witnesses: [live.seq, ev.seq],
        });
      } else if (outcome === "committed" && controller) {
        // Positively evaluated committed receipt (controller present; not a wrong-holder miss)
        if (!(fence_epoch != null && live && fence_epoch < live.epoch)) {
          if (!(live?.holder && controller !== live.holder)) {
            saw_positive_committed = true;
            positive_witnesses.push(ev.seq);
            if (live?.seq != null) positive_witnesses.push(live.seq);
          }
        }
      }
    }

    if (ev.op === "effect.dispatch") {
      const fence_epoch = num(a.fence_epoch);
      const scope_id = str(a.scope_id) ?? "default";
      const live = live_fence.get(scope_id) ?? global_epoch;
      const controller = str(a.controller) ?? str(a.holder) ?? ev.actor_id;

      if ((a.stale_fence === true || a.stale_controller === true) && (ev.kind === "ok" || str(a.status) === "committed")) {
        if (a.accepted_at_gateway === true) {
          violations.push({
            text: "test-injected marker: Stale controller dispatch accepted at effect gateway.",
            witnesses: [live?.seq, ev.seq].filter((x): x is number => typeof x === "number"),
            marker: true,
          });
        }
      }
      if (ev.kind === "ok" && fence_epoch != null && live && fence_epoch < live.epoch && a.accepted_at_gateway === true) {
        violations.push({
          text: `test-injected marker accepted_at_gateway: Stale fence_epoch=${fence_epoch} accepted at gateway (live=${live.epoch}).`,
          witnesses: [live.seq, ev.seq],
          marker: true,
        });
      }

      // Dispatch by non-live holder after handoff
      if (
        (ev.kind === "ok" || str(a.status) === "dispatched" || str(a.status) === "committed") &&
        controller &&
        live?.holder &&
        controller !== live.holder &&
        (a.accepted_at_gateway === true || str(a.status) === "committed")
      ) {
        violations.push({
          text: `Dispatch controller=${controller} is not live holder=${live.holder} after handoff/lease.`,
          witnesses: [live.seq, ev.seq],
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

  if (!saw_positive_committed) {
    const missing_note =
      missing_controller_witnesses.length > 0
        ? `. Committed receipt(s) missing controller/holder/actor_id after handoff cannot count as supported evidence; witness_seqs=[${[...new Set(missing_controller_witnesses)].sort((a, b) => a - b).join(",")}].`
        : "";
    return [
      finding(
        inv,
        cs,
        "inconclusive",
        "no committed receipt evaluated" + missing_note,
        [...new Set(missing_controller_witnesses)].sort((a, b) => a - b),
        basis(ctx),
      ),
    ];
  }

  return [
    finding(
      inv,
      cs,
      "supported",
      "No stale fence/controller commit at effect boundary observed.",
      uniq_sort(positive_witnesses),
      basis(ctx),
    ),
  ];
};
