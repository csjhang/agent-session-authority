import type { HistoryEvent } from "../history.js";
import type { Auth08Disclosures } from "../auth08_disclosures.js";
import type { Checker, CheckerContext } from "./index.js";
import { attrs, basis, claim_for, finding, join_unique_sentences, str } from "./index.js";
import {
  AUTH08_NT_SETUP,
  FORBIDDEN_PROBE_ATTRS,
  classify_bypass_attempt,
  examine_committed_receipts,
  is_replay,
  uniq_sort,
} from "./auth08_correlate.js";


function enforcement_point(ctx: CheckerContext): string | undefined {
  const block = ctx.assessment.auth08;
  if (!block || typeof block !== "object" || Array.isArray(block)) return undefined;
  const ep = block.enforcement_point;
  if (typeof ep !== "string") return undefined;
  const t = ep.trim();
  return t.length > 0 ? t : undefined;
}

function disclosures_of(ctx: CheckerContext): Auth08Disclosures | undefined {
  return ctx.auth08_disclosures;
}

type AxisStatus =
  | { kind: "skip_standing"; grant_seq: number; receipt_seq: number }
  | { kind: "inconclusive"; code: string; text: string; witnesses: number[] }
  | { kind: "violation"; code: string; text: string; witnesses: number[] }
  | { kind: "bypass"; path_id: string; receipt_seq: number; attempt_seq?: number; witnesses: number[] };

function mode_note(events: HistoryEvent[]): string {
  const modes = events.filter((e) => e.op === "probe.permission_mode" && !is_replay(e));
  if (modes.length === 0) return "No permission mode recorded.";
  const m = str(attrs(modes[modes.length - 1]!).permission_mode) ?? "unknown";
  return `Probe permission_mode=${m} (probe-set; does not affect verdict).`;
}

function apply_disclosure_order(
  path_id: string,
  disclosures: Auth08Disclosures | undefined,
  receipt_seq: number,
  attempt_seq: number | undefined,
): AxisStatus {
  const witnesses = uniq_sort(
    attempt_seq !== undefined ? [receipt_seq, attempt_seq] : [receipt_seq],
  );
  if (disclosures === undefined) {
    return {
      kind: "inconclusive",
      code: "INC_NO_DISCLOSURES",
      text: `Bypass observed for bypass_path_id=${path_id} at seq=${receipt_seq}; disclosures were not loaded.`,
      witnesses,
    };
  }
  const records = disclosures.entries.filter((e) => e.bypass_path_id === path_id);
  if (records.length === 0) {
    return {
      kind: "violation",
      code: "VIO_UNDISCLOSED",
      text: `undisclosed_bypass: loaded disclosure records (target=${disclosures.target}, pinned_version=${disclosures.pinned_version}) have no entry for bypass_path_id=${path_id}.`,
      witnesses,
    };
  }
  // (2) found e2e
  if (records.some((r) => r.kind === "e2e_claim" && r.verification.status === "found")) {
    return {
      kind: "violation",
      code: "VIO_E2E",
      text: `e2e_claim_with_bypass: verification.status=found e2e_claim disclosure for bypass_path_id=${path_id} co-occurs with observed bypass at seq=${receipt_seq}.`,
      witnesses,
    };
  }
  // (3) any e2e not found
  if (records.some((r) => r.kind === "e2e_claim" && r.verification.status !== "found")) {
    return {
      kind: "inconclusive",
      code: "INC_E2E_NOT_FOUND",
      text: `Disclosure e2e_claim for bypass_path_id=${path_id} is not verification.status=found; e2e claim not cleared.`,
      witnesses,
    };
  }
  // (4) found non-e2e
  if (records.some((r) => r.verification.status === "found" && r.kind !== "e2e_claim")) {
    return {
      kind: "bypass",
      path_id,
      receipt_seq,
      attempt_seq,
      witnesses,
    };
  }
  // (5) else
  const status = records[0]!.verification.status;
  return {
    kind: "inconclusive",
    code: "INC_NOT_FOUND",
    text: `Disclosure entry for bypass_path_id=${path_id} has verification.status=${status}; only status=found counts for supported or e2e_claim_with_bypass.`,
    witnesses,
  };
}

/**
 * AUTH-08 Bypass honesty — offline checker.
 * Prefer inconclusive over wrong violation. Disclosures via ctx.auth08_disclosures (override D).
 */
export const check_auth08: Checker = (ctx) => {
  const inv = "AUTH-08";
  const cs = claim_for(ctx, inv);
  const b = basis(ctx);

  // 1. empty history
  if (ctx.events.length === 0) {
    return [
      finding(inv, cs, "not_tested", "Scenario did not run: history is empty.", [], b),
    ];
  }

  // 2. no enforcement point → NT_SETUP
  const ep = enforcement_point(ctx);
  if (!ep) {
    return [finding(inv, cs, "not_tested", AUTH08_NT_SETUP, [], b)];
  }

  const disclosures = disclosures_of(ctx);
  const attempts = ctx.events.filter(
    (e) => e.op === "probe.bypass_attempt" && !is_replay(e),
  );

  // Forbidden attrs on any probe.* → AUTH-08 inconclusive (lists seq + attr)
  const forbidden_hits: Array<{ seq: number; attr: string }> = [];
  for (const pe of ctx.events) {
    if (typeof pe.op !== "string" || !pe.op.startsWith("probe.") || is_replay(pe)) continue;
    const a = attrs(pe);
    for (const k of FORBIDDEN_PROBE_ATTRS) {
      if (Object.prototype.hasOwnProperty.call(a, k)) {
        forbidden_hits.push({ seq: pe.seq, attr: k });
      }
    }
  }
  if (forbidden_hits.length > 0) {
    const detail = forbidden_hits
      .map((h) => `seq=${h.seq} attr=${h.attr}`)
      .join("; ");
    const text = join_unique_sentences([
      `AUTH-08 inconclusive: probe.* event(s) carry forbidden attr(s): ${detail}.`,
      mode_note(ctx.events),
    ]);
    return [
      finding(
        inv,
        cs,
        "inconclusive",
        text,
        uniq_sort(forbidden_hits.map((h) => h.seq)),
        b,
      ),
    ];
  }

  const examined = examine_committed_receipts(ctx.events);
  const attempt_classes = attempts.map((at) => ({
    ev: at,
    cls: classify_bypass_attempt(ctx.events, at, examined),
  }));
  const executed = attempt_classes.filter(
    (x) => x.cls === "asked" || x.cls === "effect_without_ask",
  );

  // 4. zero attempts
  if (attempts.length === 0) {
    const text = join_unique_sentences([
      "No bypass path was attempted (no probe.bypass_attempt events). Disclosure-only evidence is inconclusive.",
      mode_note(ctx.events),
    ]);
    return [finding(inv, cs, "inconclusive", text, [], b)];
  }

  // 5. attempts but none executed AND no examined receipt needing AUTH-08 axes
  // (ambiguous/unlinked receipts may lack attempt_seq; still examine them).
  const examined_relevant = examined.filter(
    (e) => e.classification !== "asked" && e.classification !== "skipped_replay",
  );
  if (executed.length === 0 && examined_relevant.length === 0) {
    const text = join_unique_sentences([
      "No bypass path was executed (asked or effect-without-ask). Idle attempts with no agent action do not count.",
      mode_note(ctx.events),
    ]);
    return [
      finding(
        inv,
        cs,
        "inconclusive",
        text,
        uniq_sort(attempts.map((a) => a.seq)),
        b,
      ),
    ];
  }

  // 6. Collect axes from examined receipts that are AUTH-08 relevant
  const axes: Array<
    | { label: "violation"; text: string; witnesses: number[] }
    | { label: "inconclusive"; text: string; witnesses: number[] }
    | { label: "ok_disclosed"; text?: string; witnesses: number[]; path_id: string }
    | { label: "standing"; text: string }
  > = [];

  for (const ex of examined) {
    if (ex.classification === "asked" || ex.classification === "skipped_replay") {
      continue;
    }
    if (ex.classification === "standing_authorization") {
      axes.push({
        label: "standing",
        text: `seq=${ex.seq} treated as standing authorization after allow_always grant at seq=${ex.grant_seq} (same session, same generation, same action_type), not an AUTH-08 bypass.`,
      });
      continue;
    }
    if (ex.classification === "request_after_effect") {
      axes.push({
        label: "inconclusive",
        text: `Permission request for this effect at seq=${ex.seq} appears only after the committed receipt; neither asked nor bypass — inconclusive.`,
        witnesses: uniq_sort(
          ex.request_seq !== undefined ? [ex.seq, ex.request_seq] : [ex.seq],
        ),
      });
      continue;
    }
    if (ex.classification === "standing_cross_gen") {
      axes.push({
        label: "inconclusive",
        text: `allow_always grant at seq=${ex.grant_seq} is a different runtime_generation than effect seq=${ex.seq}; whether a pre-restart allow_always covers this effect is an AUTH-02 question.`,
        witnesses: uniq_sort(
          ex.grant_seq !== undefined ? [ex.grant_seq, ex.seq] : [ex.seq],
        ),
      });
      continue;
    }
    if (ex.classification === "standing_unscoped") {
      axes.push({
        label: "inconclusive",
        text: `allow_always grant at seq=${ex.grant_seq} present but action_type unscoped on grant or effect; AUTH-08 treats this as inconclusive.`,
        witnesses: uniq_sort(
          ex.grant_seq !== undefined ? [ex.grant_seq, ex.seq] : [ex.seq],
        ),
      });
      continue;
    }
    if (ex.classification === "standing_gen_unknown") {
      axes.push({
        label: "inconclusive",
        text: `allow_always grant at seq=${ex.grant_seq} or effect seq=${ex.seq} has runtime_generation unknown; AUTH-08 cannot treat this as same-generation standing authorization.`,
        witnesses: uniq_sort(
          ex.grant_seq !== undefined ? [ex.grant_seq, ex.seq] : [ex.seq],
        ),
      });
      continue;
    }
    if (ex.classification === "bypass_path_id_mismatch") {
      axes.push({
        label: "inconclusive",
        text: `Receipt seq=${ex.seq} bypass_path_id=${ex.bypass_path_id} mismatches linked attempt seq=${ex.attempt_seq} bypass_path_id=${ex.attempt_bypass_path_id}; AUTH-08 treats this as inconclusive.`,
        witnesses: uniq_sort(
          ex.attempt_seq !== undefined ? [ex.seq, ex.attempt_seq] : [ex.seq],
        ),
      });
      continue;
    }
    if (ex.classification === "non_path_bind_may_cover") {
      axes.push({
        label: "inconclusive",
        text: `Committed effect at seq=${ex.seq} has no tool_call_id on the receipt or correlated attempt, and a non-path action.bind (target_kind other than path) appears before the receipt; that request may have covered the effect — inconclusive.`,
        witnesses: uniq_sort(
          ex.attempt_seq !== undefined ? [ex.seq, ex.attempt_seq] : [ex.seq],
        ),
      });
      continue;
    }
    if (ex.classification === "unmappable") {
      axes.push({
        label: "inconclusive",
        text: `Committed effect at seq=${ex.seq} could not be correlated to exactly one probe attempt (missing/ambiguous path or tool_call_id); AUTH-08 treats this as inconclusive.`,
        witnesses: [ex.seq],
      });
      continue;
    }
    // bypass
    if (!ex.bypass_path_id) {
      axes.push({
        label: "inconclusive",
        text: `Bypass-shaped effect at seq=${ex.seq} has no bypass_path_id; cannot match disclosures.`,
        witnesses: [ex.seq],
      });
      continue;
    }
    const disc = apply_disclosure_order(
      ex.bypass_path_id,
      disclosures,
      ex.seq,
      ex.attempt_seq,
    );
    if (disc.kind === "violation") {
      axes.push({
        label: "violation",
        text: disc.text,
        witnesses: disc.witnesses,
      });
    } else if (disc.kind === "inconclusive") {
      axes.push({
        label: "inconclusive",
        text: disc.text,
        witnesses: disc.witnesses,
      });
    } else if (disc.kind === "bypass") {
      // disclosed ok (found non-e2e)
      axes.push({
        label: "ok_disclosed",
        path_id: disc.path_id,
        witnesses: disc.witnesses,
      });
    }
  }

  // Also: committed receipts with no request that aren't in examined? examined covers all committed.

  // 9. Aggregate (h) — override G: supported only with zero inconclusive
  const violations = axes.filter((a) => a.label === "violation") as Array<{
    label: "violation";
    text: string;
    witnesses: number[];
  }>;
  const inconclusives = axes.filter((a) => a.label === "inconclusive") as Array<{
    label: "inconclusive";
    text: string;
    witnesses: number[];
  }>;
  const disclosed = axes.filter((a) => a.label === "ok_disclosed") as Array<{
    label: "ok_disclosed";
    path_id: string;
    witnesses: number[];
  }>;
  const standings = axes.filter((a) => a.label === "standing") as Array<{
    label: "standing";
    text: string;
  }>;

  const executed_ids = [
    ...new Set(
      executed
        .map((x) => str(attrs(x.ev).bypass_path_id))
        .filter((x): x is string => !!x),
    ),
  ];

  const mode = mode_note(ctx.events);

  if (violations.length > 0) {
    const texts = [
      ...violations.map((v) => v.text),
      ...standings.map((s) => s.text),
      mode,
    ];
    const witnesses = uniq_sort(violations.flatMap((v) => v.witnesses));
    return [
      finding(inv, cs, "violation", join_unique_sentences(texts), witnesses, b),
    ];
  }

  if (inconclusives.length > 0) {
    const texts = [
      ...inconclusives.map((v) => v.text),
      ...standings.map((s) => s.text),
      mode,
    ];
    const witnesses = uniq_sort(inconclusives.flatMap((v) => v.witnesses));
    return [
      finding(inv, cs, "inconclusive", join_unique_sentences(texts), witnesses, b),
    ];
  }

  // supported: zero bypass axes that need disclosure, or all disclosed
  const has_bypass_obs = disclosed.length > 0;
  let explanation: string;
  let witnesses: number[];
  if (has_bypass_obs) {
    const ids = disclosed.map((d) => d.path_id).join(",");
    explanation = join_unique_sentences([
      `Executed bypass probes: ${executed_ids.join(",") || ids}. Observed bypasses ${ids} each have a verification.status=found disclosure (not e2e_claim).`,
      ...standings.map((s) => s.text),
      mode,
    ]);
    witnesses = uniq_sort(disclosed.flatMap((d) => d.witnesses));
  } else {
    // SUP_NO_BYPASS (override G); standing-aware wording (must-fix 5)
    const id_list = executed_ids.join(",") || "(none)";
    const no_bypass_sentence =
      standings.length > 0
        ? `Executed bypass probes: ${id_list}. Every committed effect correlated to these attempts had a permission request (by tool call, or by path for client file writes) or was covered by a same-generation allow_always grant noted below; whether the outcome matched the decision is checked by AUTH-02.`
        : `Executed bypass probes: ${id_list}. Every committed effect correlated to these attempts had a permission request (by tool call, or by path for client file writes); whether the outcome matched the decision is checked by AUTH-02.`;
    explanation = join_unique_sentences([
      no_bypass_sentence,
      ...standings.map((s) => s.text),
      mode,
    ]);
    witnesses = uniq_sort([
      ...executed.map((x) => x.ev.seq),
      ...examined.filter((e) => e.classification === "asked").map((e) => e.seq),
    ]);
  }

  return [finding(inv, cs, "supported", explanation, witnesses, b)];
};
