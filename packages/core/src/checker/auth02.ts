import type { Checker } from "./index.js";
import { attrs, basis, claim_for, finding, num, str, observation_guard } from "./index.js";

/** Fields that define the action for rebound detection (nonce/runtime_generation/expiry are request identity, not rebound). */
const ACTION_DEFINING_KEYS = ["action_type", "target", "args", "policy_version"] as const;

/** Binding-field compare for receipt vs grant (unchanged set; gen mismatch also yields cross_generation_grant). */
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
  action_type?: string;
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
    action_type: str(a.action_type),
    target: str(a.target),
    args: a.args !== undefined ? JSON.stringify(a.args) : undefined,
    policy_version: str(a.policy_version),
    runtime_generation: num(a.runtime_generation),
    nonce: str(a.nonce),
    expiry: str(a.expiry),
  };
}

function changed_fields(
  approved: BindingSnap,
  current: BindingSnap,
  keys: readonly string[],
): string[] {
  const out: string[] = [];
  for (const k of keys) {
    const left = (approved as Record<string, unknown>)[k];
    const right = (current as Record<string, unknown>)[k];
    if (left === undefined || right === undefined) continue;
    if (left !== right) out.push(k);
  }
  return out;
}

type Decision = {
  seq: number;
  kind: "grant" | "deny";
  snap: BindingSnap;
  runtime_generation?: number;
  option_kind?: string;
};

type ViolationNote = { text: string; witnesses: number[]; marker?: boolean };

/**
 * AUTH-02 — action-bound approval.
 *
 * Rebound compares only action-defining fields (action_type, target, args,
 * policy_version). Different nonce/runtime_generation/expiry = new request for
 * the same action, not rebound.
 *
 * allow_once grants may be consumed by at most one effect_id (once_grant_reused).
 * Committed receipts are deduplicated by effect_id.
 */
export const check_auth02: Checker = (ctx) => {
  const inv = "AUTH-02";
  const cs = claim_for(ctx, inv);
  const has_receipt = ctx.events.some((e) => e.op === "effect.receipt");
  const guard = observation_guard(ctx, inv, has_receipt, has_receipt);
  if (guard) return guard;

  /** digest -> first binding snapshot that defined it */
  const bindings = new Map<string, BindingSnap>();
  /** Chronological grant/deny decisions (approval.record excluded). */
  const decisions: Decision[] = [];
  const violations: ViolationNote[] = [];
  const supported_witnesses: number[] = [];
  const inconclusive_witnesses: number[] = [];
  const unlinked_witnesses: number[] = [];
  /** grant seq -> effect_ids that consumed an allow_once grant */
  const once_grant_uses = new Map<number, Set<string>>();
  /** effect_ids already evaluated as committed */
  const seen_effect_ids = new Set<string>();
  let saw_supported = false;
  let saw_committed = false;
  let saw_unlinked_only = true;
  /** Counted (supported) receipts; uncompared = missing runtime_generation on grant or receipt. */
  let counted_receipts = 0;
  let uncompared_generation_receipts = 0;

  const push_violation = (text: string, witnesses: number[], marker = false) => {
    violations.push({ text, witnesses, marker });
  };

  for (const ev of ctx.events) {
    const a = attrs(ev);

    if ((ev.op === "action.bind" || ev.op === "action.propose") && (ev.kind === "ok" || ev.kind === "info" || ev.kind === "invoke")) {
      const digest = str(a.action_digest);
      if (!digest) continue;
      const snap = snap_from_attrs(ev.seq, digest, a);
      const prev = bindings.get(digest);
      if (prev) {
        const delta = changed_fields(prev, snap, ACTION_DEFINING_KEYS);
        if (delta.length > 0) {
          const approved = [...decisions].reverse().find((d) => d.kind === "grant" && d.snap.action_digest === digest);
          if (approved) {
            push_violation(
              `ActionBinding fields changed after approval (${delta.join(",")}) while reusing action_digest=${digest}.`,
              [prev.seq, approved.seq, ev.seq],
            );
          } else {
            push_violation(
              `action_digest=${digest} rebound with changed fields (${delta.join(",")}).`,
              [prev.seq, ev.seq],
            );
          }
        }
        // Non-defining field changes (nonce/runtime_generation/expiry) = new request, not rebound.
      } else {
        bindings.set(digest, snap);
      }
    }

    if (ev.op === "approval.grant" && (ev.kind === "ok" || ev.kind === "info")) {
      const digest = str(a.action_digest);
      if (!digest) continue;
      const base = bindings.get(digest) ?? snap_from_attrs(ev.seq, digest, a);
      const snap = snap_from_attrs(ev.seq, digest, { ...base, ...a, action_digest: digest });
      decisions.push({
        seq: ev.seq,
        kind: "grant",
        snap: { ...base, ...snap, action_digest: digest },
        runtime_generation: num(a.runtime_generation) ?? snap.runtime_generation,
        option_kind: str(a.option_kind),
      });
    }

    if (ev.op === "approval.deny" && (ev.kind === "ok" || ev.kind === "info" || ev.kind === "fail")) {
      const digest = str(a.action_digest);
      if (!digest) continue;
      const base = bindings.get(digest) ?? snap_from_attrs(ev.seq, digest, a);
      const snap = snap_from_attrs(ev.seq, digest, { ...base, ...a, action_digest: digest });
      decisions.push({
        seq: ev.seq,
        kind: "deny",
        snap: { ...base, ...snap, action_digest: digest },
        runtime_generation: num(a.runtime_generation) ?? snap.runtime_generation,
        option_kind: str(a.option_kind),
      });
    }

    // approval.record intentionally ignored for grant/deny matching

    if (ev.op === "effect.receipt" || ev.op === "effect.dispatch") {
      const outcome = str(a.outcome) ?? str(a.status);
      const digest = str(a.action_digest);
      const is_committed_receipt = ev.op === "effect.receipt" && outcome === "committed";

      // Marker-only paths (kept for existing corpora)
      if (a.reuse_stale_approval === true && (outcome === "committed" || outcome === "success" || outcome === "completed" || ev.op === "effect.receipt")) {
        const approved = digest
          ? [...decisions].reverse().find((d) => d.kind === "grant" && d.snap.action_digest === digest)
          : undefined;
        push_violation(
          `test-injected marker reuse_stale_approval: committed/dispatched effect reused stale approval` +
            (digest ? ` for action_digest=${digest}` : "") +
            `.`,
          [approved?.seq, ev.seq].filter((x): x is number => typeof x === "number"),
          true,
        );
      }
      if (ev.op === "effect.receipt" && outcome === "committed" && a.binding_changed_after_approval === true) {
        const approved = digest
          ? [...decisions].reverse().find((d) => d.kind === "grant" && d.snap.action_digest === digest)
          : undefined;
        push_violation(
          `test-injected marker binding_changed_after_approval with committed receipt` +
            (digest ? ` for action_digest=${digest}` : "") +
            `.`,
          [approved?.seq, ev.seq].filter((x): x is number => typeof x === "number"),
          true,
        );
      }

      // Binding-field compare against latest matching grant (existing rule; unchanged key set)
      if (digest) {
        const approved = [...decisions].reverse().find((d) => d.kind === "grant" && d.snap.action_digest === digest);
        if (approved) {
          const current = snap_from_attrs(ev.seq, digest, a);
          const delta = changed_fields(approved.snap, current, BINDING_KEYS);
          if (
            delta.length > 0 &&
            (outcome === "committed" || (ev.op === "effect.receipt" && outcome !== "rejected" && outcome !== "failed"))
          ) {
            if (ev.op === "effect.receipt" && outcome === "committed") {
              push_violation(
                `Effect committed with approval for action_digest=${digest} after binding fields changed (${delta.join(",")}).`,
                [approved.snap.seq, approved.seq, ev.seq],
              );
            }
          }
        }
      }

      if (!is_committed_receipt) {
        if (ev.op === "effect.receipt") {
          inconclusive_witnesses.push(ev.seq);
        }
        continue;
      }

      saw_committed = true;

      const effect_id = str(a.effect_id);
      // Deduplicate committed receipts by effect_id
      if (effect_id) {
        if (seen_effect_ids.has(effect_id)) {
          continue;
        }
        seen_effect_ids.add(effect_id);
      }

      // Rule 2: unlinked / no action_digest → inconclusive witness only
      if (!digest || str(a.binding) === "unlinked") {
        inconclusive_witnesses.push(ev.seq);
        unlinked_witnesses.push(ev.seq);
        continue;
      }

      saw_unlinked_only = false;

      // Rule 1: latest grant/deny before this receipt with same digest
      let latest: Decision | undefined;
      for (let i = decisions.length - 1; i >= 0; i--) {
        const d = decisions[i]!;
        if (d.seq >= ev.seq) continue;
        if (d.snap.action_digest !== digest) continue;
        latest = d;
        break;
      }

      if (!latest) {
        push_violation(
          `committed_without_grant: effect.receipt outcome=committed for action_digest=${digest} with no prior approval.grant/deny (approval.record does not count).`,
          [ev.seq],
        );
        continue;
      }

      if (latest.kind === "deny") {
        push_violation(
          `committed_after_deny: effect.receipt outcome=committed for action_digest=${digest} after latest approval.deny.`,
          [latest.seq, ev.seq],
        );
        continue;
      }

      const grant_gen = latest.runtime_generation;
      const receipt_gen = num(a.runtime_generation);
      if (grant_gen != null && receipt_gen != null && grant_gen !== receipt_gen) {
        push_violation(
          `cross_generation_grant: approval.grant runtime_generation=${grant_gen} ≠ receipt runtime_generation=${receipt_gen} for action_digest=${digest}.`,
          [latest.seq, ev.seq],
        );
        continue;
      }

      // once_grant_reused: allow_once grant consumed by two different effect_ids
      if (latest.option_kind === "allow_once" && effect_id) {
        const used = once_grant_uses.get(latest.seq) ?? new Set<string>();
        if (used.size > 0 && !used.has(effect_id)) {
          push_violation(
            `once_grant_reused: option_kind=allow_once grant at seq=${latest.seq} used by multiple effect_ids (${[...used, effect_id].join(",")}).`,
            [latest.seq, ev.seq],
          );
          used.add(effect_id);
          once_grant_uses.set(latest.seq, used);
          continue;
        }
        used.add(effect_id);
        once_grant_uses.set(latest.seq, used);
      }

      saw_supported = true;
      counted_receipts += 1;
      if (grant_gen == null || receipt_gen == null) {
        uncompared_generation_receipts += 1;
      }
      supported_witnesses.push(latest.seq, ev.seq);
    }
  }

  if (violations.length > 0) {
    const witnesses = [...new Set(violations.flatMap((v) => v.witnesses))].sort((a, b) => a - b);
    const parts = violations.map((v) => v.text);
    const marker_note = violations.some((v) => v.marker)
      ? " At least one violation used a test-injected marker."
      : "";
    return [
      finding(
        inv,
        cs,
        "violation",
        parts.join(" ") + marker_note,
        witnesses,
        basis(ctx),
      ),
    ];
  }

  if (saw_supported) {
    const unlinked_note =
      unlinked_witnesses.length > 0
        ? ` Also ${unlinked_witnesses.length} unlinked committed receipt(s) (inconclusive evidence only); witness_seqs=[${[...new Set(unlinked_witnesses)].sort((a, b) => a - b).join(",")}].`
        : "";
    const supported_explanation =
      uncompared_generation_receipts === 0
        ? "Committed effect.receipt(s) matched same-generation approval.grant; no action-bound approval reuse after binding-field change."
        : "Committed effect.receipt(s) matched approval.grant; no action-bound approval reuse after binding-field change." +
          ` runtime_generation not compared for ${uncompared_generation_receipts} of ${counted_receipts} counted receipt(s) (missing on the grant or the receipt).`;
    return [
      finding(
        inv,
        cs,
        "supported",
        supported_explanation + unlinked_note,
        [...new Set([...supported_witnesses, ...unlinked_witnesses])].sort((a, b) => a - b),
        basis(ctx),
      ),
    ];
  }

  // No violation and no supported committed evidence
  // inconclusive_witnesses mixes (a) committed unlinked receipts and (b) non-committed
  // receipts (unknown/rejected/...), which may be properly bound. Describe each group separately.
  const unlinked_set = new Set(unlinked_witnesses);
  const not_committed_seqs = [...new Set(inconclusive_witnesses.filter((s) => !unlinked_set.has(s)))].sort(
    (a, b) => a - b,
  );
  const unlinked_seqs = [...unlinked_set].sort((a, b) => a - b);
  const not_committed_note =
    not_committed_seqs.length > 0
      ? ` Receipt(s) with an outcome other than committed (no effect confirmed); witness_seqs=[${not_committed_seqs.join(",")}].`
      : "";
  const committed_unlinked_note =
    unlinked_seqs.length > 0
      ? ` Committed effect not linked to any action.bind (binding=unlinked); witness_seqs=[${unlinked_seqs.join(",")}].`
      : "";
  const unlinked_note = not_committed_note + committed_unlinked_note;
  if (!saw_committed || saw_unlinked_only) {
    return [
      finding(
        inv,
        cs,
        "inconclusive",
        (!saw_committed
          ? "No outcome=committed effect.receipt observed; AUTH-02 cannot be positively supported."
          : "All committed effect.receipt(s) are unlinked (no action_digest).") + unlinked_note,
        [...new Set(inconclusive_witnesses)].sort((a, b) => a - b),
        basis(ctx),
      ),
    ];
  }

  return [
    finding(
      inv,
      cs,
      "inconclusive",
      "No committed receipt counted as supported evidence." + unlinked_note,
      [...new Set([...supported_witnesses, ...inconclusive_witnesses])].sort((a, b) => a - b),
      basis(ctx),
    ),
  ];
};
