import type { Checker } from "./index.js";
import { attrs, basis, claim_for, finding, num, str, observation_guard } from "./index.js";

function uniq_sort(seqs: number[]): number[] {
  return [...new Set(seqs)].sort((a, b) => a - b);
}

type FenceRecord = {
  epoch: number;
  seq: number;
  holder?: string;
  superseded: boolean;
};

/**
 * AUTH-04 — fencing at effect boundary with sticky superseded flag and scope attribution.
 * Superseded only when a record is actually updated (epoch up; same-epoch holder change;
 * handoff; revoke/release raising epoch). Lower-epoch acquire/handoff must not mark superseded.
 * Missing-controller trigger = prior control.handoff (ok|info), not "any record superseded".
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

  const live_fence = new Map<string, FenceRecord>();
  let global_epoch: FenceRecord | undefined;
  const violations: { text: string; witnesses: number[]; marker?: boolean }[] = [];
  let saw_positive_after_change = false;
  let saw_positive_evaluated = false;
  const positive_witnesses: number[] = [];
  const missing_controller_witnesses: number[] = [];
  const unattributed_witnesses: number[] = [];
  let any_fence = false;
  let handoff_seen = false;

  const mark_superseded = (rec: FenceRecord | undefined) => {
    if (rec) rec.superseded = true;
  };

  const bump = (scope_id: string | undefined, epoch: number, seq: number, holder?: string) => {
    any_fence = true;
    if (scope_id) {
      const cur = live_fence.get(scope_id);
      if (!cur) {
        live_fence.set(scope_id, { epoch, seq, holder, superseded: false });
      } else if (epoch > cur.epoch) {
        mark_superseded(cur);
        live_fence.set(scope_id, {
          epoch,
          seq,
          holder: holder ?? cur.holder,
          superseded: cur.superseded,
        });
      } else if (epoch === cur.epoch) {
        const holder_change = holder != null && cur.holder != null && holder !== cur.holder;
        if (holder_change) mark_superseded(cur);
        live_fence.set(scope_id, {
          epoch,
          seq,
          holder: holder ?? cur.holder,
          superseded: cur.superseded,
        });
      }
      // epoch < cur.epoch: lower-epoch must not update live holder or mark superseded
    }
    if (!global_epoch) {
      global_epoch = { epoch, seq, holder, superseded: false };
    } else if (epoch > global_epoch.epoch) {
      mark_superseded(global_epoch);
      global_epoch = {
        epoch,
        seq,
        holder: holder ?? global_epoch.holder,
        superseded: global_epoch.superseded,
      };
    } else if (epoch === global_epoch.epoch) {
      const holder_change =
        holder != null && global_epoch.holder != null && holder !== global_epoch.holder;
      if (holder_change) mark_superseded(global_epoch);
      global_epoch = {
        epoch,
        seq,
        holder: holder ?? global_epoch.holder,
        superseded: global_epoch.superseded,
      };
    }
  };

  const set_holder = (scope_id: string | undefined, holder: string, seq: number) => {
    any_fence = true;
    if (scope_id) {
      const cur = live_fence.get(scope_id);
      if (cur) {
        if (cur.holder != null && cur.holder !== holder) mark_superseded(cur);
        live_fence.set(scope_id, { ...cur, holder, seq });
      } else {
        live_fence.set(scope_id, {
          epoch: global_epoch?.epoch ?? 0,
          seq,
          holder,
          superseded: false,
        });
      }
    }
    if (global_epoch) {
      if (global_epoch.holder != null && global_epoch.holder !== holder) mark_superseded(global_epoch);
      global_epoch = { ...global_epoch, holder, seq };
    }
  };

  /** Attribute receipt/dispatch to a fence record; undefined = unattributed. */
  const attribute = (scope_id: string | undefined): FenceRecord | undefined | "unattributed" => {
    if (scope_id && live_fence.has(scope_id)) return live_fence.get(scope_id);
    if (live_fence.size === 0) return global_epoch;
    if (!scope_id && live_fence.size === 1) return [...live_fence.values()][0];
    if (!scope_id && live_fence.size !== 1) return "unattributed";
    if (scope_id && !live_fence.has(scope_id)) return "unattributed";
    return "unattributed";
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

      // Lower-epoch handoff must NOT mark superseded or update live holder.
      let lower_epoch_noop = false;
      if (epoch != null) {
        if (scope_id && live_fence.has(scope_id)) {
          const cur = live_fence.get(scope_id)!;
          if (epoch < cur.epoch) lower_epoch_noop = true;
        } else if (!scope_id && live_fence.size === 0 && global_epoch && epoch < global_epoch.epoch) {
          lower_epoch_noop = true;
        } else if (!scope_id && live_fence.size === 1) {
          const only = [...live_fence.values()][0]!;
          if (epoch < only.epoch) lower_epoch_noop = true;
        }
      }

      if (!lower_epoch_noop) {
        // Handoff that updates (or has no lower-epoch conflict) marks superseded
        if (scope_id && live_fence.has(scope_id)) mark_superseded(live_fence.get(scope_id));
        else if (live_fence.size === 0 && global_epoch) mark_superseded(global_epoch);
        else if (!scope_id && live_fence.size === 1) mark_superseded([...live_fence.values()][0]);
        else if (!scope_id && live_fence.size > 1) {
          for (const rec of live_fence.values()) mark_superseded(rec);
          mark_superseded(global_epoch);
        } else if (scope_id && !live_fence.has(scope_id)) {
          // new scope via handoff — bump below creates record; no prior to mark
        }
        if (epoch != null) bump(scope_id, epoch, ev.seq, holder ?? undefined);
        else if (holder) set_holder(scope_id, holder, ev.seq);
      }
    }

    if ((ev.op === "lease.revoke" || ev.op === "lease.release") && (ev.kind === "ok" || ev.kind === "info")) {
      const epoch = num(a.fence_epoch);
      const scope_id = str(a.scope_id);
      const raised = num(a.new_fence_epoch);
      if (raised != null) {
        if (scope_id && live_fence.has(scope_id)) mark_superseded(live_fence.get(scope_id));
        bump(scope_id, raised, ev.seq);
      } else if (epoch != null && scope_id) {
        if (a.stale === true || a.invalidate_fence === true) {
          if (live_fence.has(scope_id)) mark_superseded(live_fence.get(scope_id));
          bump(scope_id, epoch + 1, ev.seq);
        }
      }
    }

    if (ev.op === "effect.receipt") {
      const outcome = str(a.outcome);
      const fence_epoch = num(a.fence_epoch);
      const scope_id = str(a.scope_id); // no default→global
      const attributed = attribute(scope_id);
      const controller = str(a.controller) ?? str(a.holder) ?? ev.actor_id;

      if (attributed === "unattributed") {
        if (outcome === "committed" && (any_fence || live_fence.size > 0 || global_epoch)) {
          unattributed_witnesses.push(ev.seq);
        }
        continue;
      }

      const live = attributed;

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

      // Missing controller after prior control.handoff (not "any superseded")
      if (outcome === "committed" && handoff_seen && !controller) {
        missing_controller_witnesses.push(ev.seq);
        continue;
      }

      if (outcome === "committed" && controller && live?.holder && controller !== live.holder) {
        violations.push({
          text: `Committed effect controller=${controller} is not live holder=${live.holder} after handoff/lease (fence_epoch may be unchanged).`,
          witnesses: [live.seq, ev.seq],
        });
      } else if (outcome === "committed" && controller) {
        const stale_epoch = fence_epoch != null && live && fence_epoch < live.epoch;
        const wrong_holder = !!(live?.holder && controller !== live.holder);
        if (!stale_epoch && !wrong_holder) {
          // positively evaluated committed
          saw_positive_evaluated = true;
          if (live?.superseded) {
            saw_positive_after_change = true;
            positive_witnesses.push(ev.seq);
            if (live.seq != null) positive_witnesses.push(live.seq);
          }
        }
      }
    }

    if (ev.op === "effect.dispatch") {
      const fence_epoch = num(a.fence_epoch);
      const scope_id = str(a.scope_id);
      const attributed = attribute(scope_id);
      if (attributed === "unattributed") continue;
      const live = attributed;
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

  const missing_note =
    missing_controller_witnesses.length > 0
      ? ` Committed receipt(s) missing controller/holder/actor_id after handoff cannot count as supported evidence; witness_seqs=[${uniq_sort(missing_controller_witnesses).join(",")}].`
      : "";
  const unattributed_note =
    unattributed_witnesses.length > 0
      ? ` Committed receipt(s) whose scope cannot be attributed to a fence record are not evidence; witness_seqs=[${uniq_sort(unattributed_witnesses).join(",")}].`
      : "";

  if (violations.length > 0) {
    // violation witnesses = counterexamples only; unattributed tip in explanation OK
    const witnesses = uniq_sort(violations.flatMap((v) => v.witnesses));
    const marker_note = violations.some((v) => v.marker) ? " Includes test-injected marker." : "";
    const tip = unattributed_note; // explanation tip only
    return [
      finding(
        inv,
        cs,
        "violation",
        violations.map((v) => v.text).join(" ") + marker_note + tip,
        witnesses,
        basis(ctx),
      ),
    ];
  }

  if (saw_positive_after_change) {
    return [
      finding(
        inv,
        cs,
        "supported",
        "No stale fence/controller commit at effect boundary observed." + unattributed_note,
        uniq_sort(positive_witnesses),
        basis(ctx),
      ),
    ];
  }

  // Per-receipt: positively evaluated but attributed records not superseded → no fence change
  // Zero positive → no committed receipt evaluated. Do not use whole-history superseded flags.
  const opening = saw_positive_evaluated ? "no fence change examined" : "no committed receipt evaluated";
  // Order: opening → missing controller → unattributed, joined as "opening. Note ..."; a bare opening has no period.
  const bare = missing_note === "" && unattributed_note === "";
  const final_explanation = bare ? opening : opening + "." + missing_note + unattributed_note;

  return [
    finding(
      inv,
      cs,
      "inconclusive",
      final_explanation,
      uniq_sort([...unattributed_witnesses, ...missing_controller_witnesses]),
      basis(ctx),
    ),
  ];
};
