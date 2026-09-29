import type { Checker } from "./index.js";
import { attrs, basis, claim_for, finding, num, str, observation_guard } from "./index.js";

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

type Decision = {
  seq: number;
  kind: "grant" | "deny";
  snap: BindingSnap;
  runtime_generation?: number;
};

type ViolationNote = { text: string; witnesses: number[]; marker?: boolean };

/**
 * AUTH-02 — action-bound approval.
 *
 * For each outcome=committed effect.receipt:
 * 1. With action_digest: find latest approval.grant/approval.deny before this
 *    receipt with the same action_digest (approval.record never counts).
 *    - none → committed_without_grant
 *    - latest deny → committed_after_deny
 *    - latest grant but grant.runtime_generation ≠ receipt.runtime_generation
 *      → cross_generation_grant
 *    - else this receipt counts as supported evidence
 * 2. No action_digest (binding=unlinked) → receipt only inconclusive
 * 3. Overall: any violation → violation; else ≥1 supported evidence → supported;
 *    else (no committed or all unlinked) → inconclusive
 * 4. Prerequisite: any effect.receipt is enough to evaluate
 * 5. Existing binding-field compares (target, args, policy_version, nonce, expiry,
 *    runtime_generation) still apply.
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
  let saw_supported = false;
  let saw_committed = false;
  let saw_unlinked_only = true;

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
        const delta = changed_fields(prev, snap);
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

      // Binding-field compare against latest matching grant (existing rule)
      if (digest) {
        const approved = [...decisions].reverse().find((d) => d.kind === "grant" && d.snap.action_digest === digest);
        if (approved) {
          const current = snap_from_attrs(ev.seq, digest, a);
          const delta = changed_fields(approved.snap, current);
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

      // Rule 2: unlinked / no action_digest → inconclusive witness only
      if (!digest || str(a.binding) === "unlinked") {
        inconclusive_witnesses.push(ev.seq);
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

      saw_supported = true;
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
    return [
      finding(
        inv,
        cs,
        "supported",
        "Committed effect.receipt(s) matched same-generation approval.grant; no action-bound approval reuse after binding-field change.",
        [...new Set(supported_witnesses)].sort((a, b) => a - b),
        basis(ctx),
      ),
    ];
  }

  // No violation and no supported committed evidence
  const unlinked_note =
    inconclusive_witnesses.length > 0
      ? ` Committed effect not linked to any action.bind (binding=unlinked); witness_seqs=[${[...new Set(inconclusive_witnesses)].sort((a, b) => a - b).join(",")}].`
      : "";
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

