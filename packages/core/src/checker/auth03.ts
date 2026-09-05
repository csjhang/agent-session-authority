import type { Checker } from "./index.js";
import { attrs, basis, claim_for, finding, num, str } from "./index.js";
import { resolve_scope_id } from "../declaration.js";

/** AUTH-03a — scope determinism; actors must not self-declare conflicting scope */
export const check_auth03a: Checker = (ctx) => {
  const inv = "AUTH-03a";
  const cs = claim_for(ctx, inv);
  for (const ev of ctx.events) {
    if (ev.op !== "action.bind" && ev.op !== "action.propose") continue;
    const a = attrs(ev);
    const action_type = str(a.action_type);
    const target = str(a.target);
    const self_scope = str(a.scope_id);
    if (!action_type || !target || !self_scope) continue;
    const expected = resolve_scope_id(ctx.profile, action_type, target);
    if (expected != null && expected !== self_scope) {
      return [finding(inv, cs, "violation",
        `Self-declared scope_id=${self_scope} != profile mapping ${expected} for ${action_type}|${target}.`,
        [ev.seq], basis(ctx))];
    }
    if (a.self_declared_scope === true && expected == null) {
      return [finding(inv, cs, "violation",
        `Actor self-declared scope_id=${self_scope} without published scope decision function.`,
        [ev.seq], basis(ctx))];
    }
  }
  const seen = new Map<string, string>();
  for (const row of ctx.profile?.scope_map ?? []) {
    const key = `${row.action_type}|${row.target}`;
    const prev = seen.get(key);
    if (prev && prev !== row.scope_id) {
      return [finding(inv, cs, "violation", `Non-deterministic scope map for ${key}.`, [], basis(ctx))];
    }
    seen.set(key, row.scope_id);
  }
  return [finding(inv, cs === "not_declared" ? "declared" : cs, "supported", "Scope determinism holds on observed bindings.", [], basis(ctx))];
};

/** AUTH-03b — single controller per (scope_id, fence_epoch) */
export const check_auth03b: Checker = (ctx) => {
  const inv = "AUTH-03b";
  const cs = claim_for(ctx, inv);
  type Lease = { holder: string; seq: number; active: boolean };
  const leases = new Map<string, Lease[]>();
  const key_of = (scope_id: string, fence_epoch: number) => `${scope_id}|${fence_epoch}`;

  for (const ev of ctx.events) {
    const a = attrs(ev);
    if (ev.op === "lease.acquire" && (ev.kind === "ok" || (ev.kind === "info" && a.accepted === true))) {
      const scope_id = str(a.scope_id);
      const fence_epoch = num(a.fence_epoch);
      const holder = str(a.holder) ?? ev.actor_id;
      if (!scope_id || fence_epoch == null || !holder) continue;
      const k = key_of(scope_id, fence_epoch);
      const list = leases.get(k) ?? [];
      const active = list.filter((l) => l.active);
      if (active.length >= 1 && !active.some((l) => l.holder === holder)) {
        return [finding(inv, cs, "violation",
          `Second ControlLease holder=${holder} while ${active[0]!.holder} active on ${k}.`,
          [active[0]!.seq, ev.seq], basis(ctx))];
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
  }
  return [finding(inv, cs === "not_declared" ? "declared" : cs, "supported", "At most one active ControlLease per scope+epoch observed.", [], basis(ctx))];
};

/** AUTH-03c — action scope must be covered by holder lease */
export const check_auth03c: Checker = (ctx) => {
  const inv = "AUTH-03c";
  const cs = claim_for(ctx, inv);
  const active = new Map<string, { holder: string; scopes: Set<string>; seq: number }>();

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
    if (ev.op === "effect.receipt") {
      const outcome = str(a.outcome);
      if (outcome !== "committed") continue;
      const scope_id = str(a.scope_id);
      const actor = str(a.controller) ?? str(a.holder) ?? ev.actor_id;
      if (!scope_id || !actor) continue;
      const lease = active.get(actor);
      if (!lease || !lease.scopes.has(scope_id)) {
        return [finding(inv, cs, "violation",
          `Committed effect scope_id=${scope_id} not covered by holder=${actor} ControlLease.`,
          [lease?.seq, ev.seq].filter((x): x is number => typeof x === "number"), basis(ctx))];
      }
    }
  }
  return [finding(inv, cs === "not_declared" ? "declared" : cs, "supported", "Committed effects stayed within holder lease scopes.", [], basis(ctx))];
};

export const check_auth03: Checker = (ctx) => [
  ...check_auth03a(ctx),
  ...check_auth03b(ctx),
  ...check_auth03c(ctx),
];
