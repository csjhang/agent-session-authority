import type { Checker } from "./index.js";
import { attrs, basis, claim_for, finding, num, str, observation_guard } from "./index.js";
import { resolve_scope_id } from "../declaration.js";

function ts_millis(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : undefined;
}

/** AUTH-03a — scope determinism; actors must not self-declare conflicting scope */
export const check_auth03a: Checker = (ctx) => {
  const inv = "AUTH-03a";
  const cs = claim_for(ctx, inv);
  const guard = observation_guard(ctx, inv, ctx.profile != null, ctx.events.some((e) => e.op === "action.bind" || e.op === "action.propose"));
  if (guard) return guard;
  const violations: { text: string; witnesses: number[] }[] = [];
  for (const ev of ctx.events) {
    if (ev.op !== "action.bind" && ev.op !== "action.propose") continue;
    const a = attrs(ev);
    const action_type = str(a.action_type);
    const target = str(a.target);
    const self_scope = str(a.scope_id);
    if (!action_type || !target || !self_scope) continue;
    const expected = resolve_scope_id(ctx.profile, action_type, target);
    if (expected != null && expected !== self_scope) {
      violations.push({
        text: `Self-declared scope_id=${self_scope} != profile mapping ${expected} for ${action_type}|${target}.`,
        witnesses: [ev.seq],
      });
    }
    if (a.self_declared_scope === true && expected == null) {
      violations.push({
        text: `Actor self-declared scope_id=${self_scope} without published scope decision function.`,
        witnesses: [ev.seq],
      });
    }
  }
  const seen = new Map<string, string>();
  for (const row of ctx.profile?.scope_map ?? []) {
    const key = `${row.action_type}|${row.target}`;
    const prev = seen.get(key);
    if (prev && prev !== row.scope_id) {
      violations.push({ text: `Non-deterministic scope map for ${key}.`, witnesses: [] });
    }
    seen.set(key, row.scope_id);
  }
  if (violations.length > 0) {
    const witnesses = [...new Set(violations.flatMap((v) => v.witnesses))].sort((a, b) => a - b);
    return [finding(inv, cs, "violation", violations.map((v) => v.text).join(" "), witnesses, basis(ctx))];
  }
  return [finding(inv, cs, "supported", "Scope determinism holds on observed bindings.", [], basis(ctx))];
};

/** AUTH-03b — single controller per (scope_id, fence_epoch) */
export const check_auth03b: Checker = (ctx) => {
  const inv = "AUTH-03b";
  const cs = claim_for(ctx, inv);
  const guard = observation_guard(ctx, inv, ctx.events.some((e) => e.op === "lease.acquire"), ctx.events.some((e) => e.op === "lease.acquire"));
  if (guard) return guard;
  type Lease = { holder: string; seq: number; active: boolean };
  const leases = new Map<string, Lease[]>();
  const key_of = (scope_id: string, fence_epoch: number) => `${scope_id}|${fence_epoch}`;
  const violations: { text: string; witnesses: number[] }[] = [];
  let saw_accepted = false;

  for (const ev of ctx.events) {
    const a = attrs(ev);
    if (ev.op === "lease.acquire" && (ev.kind === "ok" || (ev.kind === "info" && a.accepted === true))) {
      const scope_id = str(a.scope_id);
      const fence_epoch = num(a.fence_epoch);
      const holder = str(a.holder) ?? ev.actor_id;
      if (!scope_id || fence_epoch == null || !holder) continue;
      saw_accepted = true;
      const k = key_of(scope_id, fence_epoch);
      const list = leases.get(k) ?? [];
      const active = list.filter((l) => l.active);
      if (active.length >= 1 && !active.some((l) => l.holder === holder)) {
        violations.push({
          text: `Second ControlLease holder=${holder} while ${active[0]!.holder} active on ${k}.`,
          witnesses: [active[0]!.seq, ev.seq],
        });
      }
      list.push({ holder, seq: ev.seq, active: true });
      leases.set(k, list);
    }
    if ((ev.op === "lease.release" || ev.op === "lease.revoke") && (ev.kind === "ok" || ev.kind === "info")) {
      const scope_id = str(a.scope_id);
      const fence_epoch = num(a.fence_epoch);
      const holder = str(a.holder) ?? ev.actor_id;
      if (!scope_id || fence_epoch == null) continue;
      const k = key_of(scope_id, fence_epoch);
      const list = leases.get(k) ?? [];
      for (const l of list) {
        if (l.active && (!holder || l.holder === holder)) l.active = false;
      }
      leases.set(k, list);
    }
    if (ev.op === "control.handoff" && (ev.kind === "ok" || ev.kind === "info")) {
      const scope_id = str(a.scope_id);
      const fence_epoch = num(a.fence_epoch) ?? num(a.new_fence_epoch);
      const from = str(a.from) ?? str(a.predecessor) ?? ev.actor_id;
      const to = str(a.to) ?? str(a.holder) ?? str(a.successor);
      if (!scope_id || fence_epoch == null || !to) continue;
      // Release old holder on this scope+epoch, activate successor
      const k = key_of(scope_id, fence_epoch);
      const list = leases.get(k) ?? [];
      for (const l of list) {
        if (l.active && (!from || l.holder === from)) l.active = false;
      }
      list.push({ holder: to, seq: ev.seq, active: true });
      leases.set(k, list);
    }
  }
  if (violations.length > 0) {
    const witnesses = [...new Set(violations.flatMap((v) => v.witnesses))].sort((a, b) => a - b);
    return [finding(inv, cs, "violation", violations.map((v) => v.text).join(" "), witnesses, basis(ctx))];
  }
  if (!saw_accepted) {
    return [
      finding(
        inv,
        cs,
        "inconclusive",
        "no accepted lease.acquire evaluated",
        [],
        basis(ctx),
      ),
    ];
  }
  return [finding(inv, cs, "supported", "At most one active ControlLease per scope+epoch observed.", [], basis(ctx))];
};

/** AUTH-03c — action scope must be covered by holder lease */
export const check_auth03c: Checker = (ctx) => {
  const inv = "AUTH-03c";
  const cs = claim_for(ctx, inv);
  const guard = observation_guard(
    ctx,
    inv,
    ctx.events.some((e) => e.op === "lease.acquire" || e.op === "control.handoff"),
    ctx.events.some((e) => e.op === "effect.receipt"),
  );
  if (guard) return guard;

  type LeaseState = {
    holder: string;
    scopes: Set<string>;
    seq: number;
    expires_at?: string;
  };
  const active = new Map<string, LeaseState>();
  const violations: { text: string; witnesses: number[] }[] = [];
  let saw_positive_committed = false;
  const missing_ts_witnesses: number[] = [];

  for (const ev of ctx.events) {
    const a = attrs(ev);
    if (ev.op === "lease.acquire" && (ev.kind === "ok" || (ev.kind === "info" && a.accepted === true))) {
      const holder = str(a.holder) ?? ev.actor_id;
      const scope_id = str(a.scope_id);
      const fence_epoch = num(a.fence_epoch);
      if (!holder || !scope_id || fence_epoch == null) continue;
      const cur = active.get(holder) ?? { holder, scopes: new Set(), seq: ev.seq };
      cur.scopes.add(scope_id);
      cur.seq = ev.seq;
      const expires = str(a.expires_at) ?? str(a.expiry);
      // Re-acquire without expires_at clears old expires_at
      if (expires) cur.expires_at = expires;
      else delete cur.expires_at;
      active.set(holder, cur);
    }
    if ((ev.op === "lease.release" || ev.op === "lease.revoke") && (ev.kind === "ok" || ev.kind === "info")) {
      const holder = str(a.holder) ?? ev.actor_id;
      const scope_id = str(a.scope_id);
      if (!holder) continue;
      const cur = active.get(holder);
      if (cur && scope_id) cur.scopes.delete(scope_id);
      if (cur && cur.scopes.size === 0) active.delete(holder);
    }
    if (ev.op === "control.handoff" && (ev.kind === "ok" || ev.kind === "info")) {
      const scope_id = str(a.scope_id);
      const from_attr = str(a.from) ?? str(a.predecessor);
      const to = str(a.to) ?? str(a.holder) ?? str(a.successor);
      if (!scope_id || !to) continue;

      // If from/predecessor/actor_id all missing, remove scope from all holders except `to`.
      if (from_attr == null && !ev.actor_id) {
        for (const [holder, old] of [...active.entries()]) {
          if (holder === to) continue;
          old.scopes.delete(scope_id);
          if (old.scopes.size === 0) active.delete(holder);
        }
      } else {
        const from = from_attr ?? ev.actor_id;
        if (from) {
          const old = active.get(from);
          if (old) {
            old.scopes.delete(scope_id);
            if (old.scopes.size === 0) active.delete(from);
          }
        }
      }

      const neu = active.get(to) ?? { holder: to, scopes: new Set(), seq: ev.seq };
      neu.scopes.add(scope_id);
      neu.seq = ev.seq;
      const expires = str(a.expires_at) ?? str(a.expiry);
      if (expires) neu.expires_at = expires;
      else delete neu.expires_at;
      active.set(to, neu);
    }
    if (ev.op === "effect.receipt") {
      const outcome = str(a.outcome);
      if (outcome !== "committed") continue;
      const scope_id = str(a.scope_id);
      const actor = str(a.controller) ?? str(a.holder) ?? ev.actor_id;
      if (!scope_id || !actor) continue;
      const lease = active.get(actor);
      const ts = ev.ts;
      const receipt_ms = ts_millis(ts);
      const expires_ms = ts_millis(lease?.expires_at);
      if (!lease || !lease.scopes.has(scope_id)) {
        violations.push({
          text: `Committed effect scope_id=${scope_id} not covered by holder=${actor} ControlLease.`,
          witnesses: [lease?.seq, ev.seq].filter((x): x is number => typeof x === "number"),
        });
        continue;
      }
      // Lease has expires_at but receipt missing/unparseable ts → cannot judge expiry.
      if (lease.expires_at && expires_ms != null && receipt_ms == null) {
        missing_ts_witnesses.push(ev.seq);
        continue;
      }
      const expired =
        expires_ms != null && receipt_ms != null && receipt_ms > expires_ms;
      if (expired) {
        violations.push({
          text: `Committed effect scope_id=${scope_id} past lease expires_at=${lease.expires_at} for holder=${actor}.`,
          witnesses: [lease.seq, ev.seq],
        });
      } else {
        saw_positive_committed = true;
      }
    }
  }
  if (violations.length > 0) {
    const witnesses = [...new Set(violations.flatMap((v) => v.witnesses))].sort((a, b) => a - b);
    return [finding(inv, cs, "violation", violations.map((v) => v.text).join(" "), witnesses, basis(ctx))];
  }
  if (!saw_positive_committed) {
    const missing_ts_note =
      missing_ts_witnesses.length > 0
        ? ` Committed receipt(s) missing ts while lease has expires_at cannot judge expiry; witness_seqs=[${[...new Set(missing_ts_witnesses)].sort((a, b) => a - b).join(",")}].`
        : "";
    return [
      finding(
        inv,
        cs,
        "inconclusive",
        "no committed receipt evaluated" + (missing_ts_note ? "." + missing_ts_note : ""),
        [...new Set(missing_ts_witnesses)].sort((a, b) => a - b),
        basis(ctx),
      ),
    ];
  }
  return [finding(inv, cs, "supported", "Committed effects stayed within holder lease scopes.", [], basis(ctx))];
};

export const check_auth03: Checker = (ctx) => [
  ...check_auth03a(ctx),
  ...check_auth03b(ctx),
  ...check_auth03c(ctx),
];
