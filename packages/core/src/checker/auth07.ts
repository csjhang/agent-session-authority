import type { Checker } from "./index.js";
import { attrs, basis, claim_for, finding, str } from "./index.js";

type TerminalKind = "cancel" | "complete" | "timeout" | "restart" | "failed" | "unknown";

interface TerminalEvent {
  seq: number;
  kind: TerminalKind;
  subject: string;
  published?: string;
}

function subject_of(a: Record<string, unknown>, ev_session?: string): string | undefined {
  return str(a.effect_id) ?? str(a.task_id) ?? str(a.subject_id) ?? ev_session;
}

function classify(ev_op: string | undefined, a: Record<string, unknown>, fault?: string): TerminalKind | undefined {
  const t = str(a.terminal) ?? str(a.terminal_kind) ?? str(a.status);
  if (t === "cancelled" || t === "canceled" || t === "cancel") return "cancel";
  if (t === "completed" || t === "complete" || t === "committed" || t === "success") return "complete";
  if (t === "timeout" || t === "timed_out") return "timeout";
  if (t === "failed" || t === "fail") return "failed";
  if (t === "unknown" || t === "orphaned") return "unknown";
  if (ev_op === "task.cancel" || ev_op === "effect.cancel") return "cancel";
  if (ev_op === "task.complete") return "complete";
  if (ev_op === "task.timeout") return "timeout";
  if (ev_op === "task.reconcile") return undefined;
  if (fault === "runtime.restart" || fault === "runtime.crash") return "restart";
  return undefined;
}

/**
 * AUTH-07 — deterministic terminal interpretation.
 * Cancel/complete/timeout/restart races require a published rule or reconciliation,
 * not guessing. Ambiguous or wrong terminals are violations.
 */
export const check_auth07: Checker = (ctx) => {
  const inv = "AUTH-07";
  const cs = claim_for(ctx, inv);

  const profile_rules = (ctx.profile?.terminal_rules ?? {}) as Record<string, string>;
  const has_published_rules = Object.keys(profile_rules).length > 0;

  const terminals = new Map<string, TerminalEvent[]>();
  const reconciles = new Map<string, { seq: number; resolved: string }>();

  for (const ev of ctx.events) {
    const a = attrs(ev);

    if (ev.op === "task.reconcile" || ev.op === "effect.reconcile" || a.reconcile === true) {
      const subject = subject_of(a, ev.session_id);
      const resolved = str(a.resolved_terminal) ?? str(a.terminal) ?? str(a.resolution);
      if (subject && resolved) {
        reconciles.set(subject, { seq: ev.seq, resolved });
      }
      continue;
    }

    const kind = classify(ev.op, a, ev.fault);
    if (!kind) continue;
    // Only count explicit terminal publications / race participants
    if (
      ev.op === "task.cancel" ||
      ev.op === "task.complete" ||
      ev.op === "task.timeout" ||
      ev.op === "effect.cancel" ||
      a.terminal != null ||
      a.terminal_kind != null ||
      (ev.kind === "fault" && (ev.fault === "runtime.restart" || ev.fault === "runtime.crash")) ||
      (ev.op === "effect.receipt" && (str(a.outcome) === "committed" || str(a.outcome) === "failed" || str(a.outcome) === "unknown"))
    ) {
      const subject = subject_of(a, ev.session_id) ?? (ev.kind === "fault" ? `fault:${ev.seq}` : undefined);
      if (!subject) continue;
      // Map receipt committed to complete for race detection when task_id/effect_id present
      let k = kind;
      if (ev.op === "effect.receipt" && str(a.outcome) === "committed") k = "complete";
      if (ev.op === "effect.receipt" && str(a.outcome) === "unknown") k = "unknown";
      const list = terminals.get(subject) ?? [];
      list.push({ seq: ev.seq, kind: k, subject, published: str(a.published_terminal) ?? str(a.terminal) });
      terminals.set(subject, list);
    }
  }

  for (const [subject, events] of terminals) {
    const kinds = new Set(events.map((e) => e.kind));
    const race_pairs: Array<[TerminalKind, TerminalKind]> = [
      ["cancel", "complete"],
      ["timeout", "complete"],
      ["cancel", "timeout"],
      ["restart", "complete"],
      ["restart", "cancel"],
    ];

    for (const [a, b] of race_pairs) {
      if (!(kinds.has(a) && kinds.has(b))) continue;
      const witnesses = events.filter((e) => e.kind === a || e.kind === b).map((e) => e.seq);
      const rec = reconciles.get(subject);
      const rule_key = `${a}_vs_${b}`;
      const alt_key = `${b}_vs_${a}`;
      const rule = profile_rules[rule_key] ?? profile_rules[alt_key];

      if (!rec && !rule && !has_published_rules) {
        return [
          finding(
            inv,
            cs,
            "violation",
            `Ambiguous terminal race (${a} vs ${b}) for ${subject} without published rule or reconciliation.`,
            witnesses.sort((x, y) => x - y),
            basis(ctx),
          ),
        ];
      }

      if (!rec && has_published_rules && !rule) {
        return [
          finding(
            inv,
            cs,
            "violation",
            `Terminal race (${a} vs ${b}) for ${subject} not covered by published terminal_rules.`,
            witnesses.sort((x, y) => x - y),
            basis(ctx),
          ),
        ];
      }

      // Wrong published terminal: both claimed as definitive without matching rule winner
      const published = events.map((e) => e.published).filter(Boolean) as string[];
      if (published.includes("completed") && published.includes("cancelled") && !rec) {
        return [
          finding(
            inv,
            cs,
            "violation",
            `Conflicting published terminals for ${subject} (completed and cancelled) without reconciliation.`,
            witnesses.sort((x, y) => x - y),
            basis(ctx),
          ),
        ];
      }

      if (rec && rule) {
        // If rule says cancel_wins but resolved to complete → violation
        if (rule === "cancel_wins" && (rec.resolved === "completed" || rec.resolved === "complete") && a === "cancel") {
          return [
            finding(
              inv,
              cs,
              "violation",
              `Reconciliation resolved to ${rec.resolved} but published rule ${rule_key}=${rule}.`,
              [...witnesses, rec.seq].sort((x, y) => x - y),
              basis(ctx),
            ),
          ];
        }
        if (rule === "complete_wins" && (rec.resolved === "cancelled" || rec.resolved === "canceled") && b === "complete") {
          return [
            finding(
              inv,
              cs,
              "violation",
              `Reconciliation resolved to ${rec.resolved} but published rule ${rule_key}=${rule}.`,
              [...witnesses, rec.seq].sort((x, y) => x - y),
              basis(ctx),
            ),
          ];
        }
      }
    }

    // Explicit ambiguous marker
    if (events.some((e) => e.kind === "unknown") && events.some((e) => e.kind === "complete" || e.kind === "cancel") && !reconciles.has(subject)) {
      const witnesses = events.map((e) => e.seq);
      return [
        finding(
          inv,
          cs,
          "violation",
          `Unknown terminal coexists with another terminal for ${subject} without reconciliation.`,
          witnesses.sort((x, y) => x - y),
          basis(ctx),
        ),
      ];
    }
  }

  // Corpus may mark attrs.ambiguous_terminal on a single event
  for (const ev of ctx.events) {
    const a = attrs(ev);
    if (a.ambiguous_terminal === true || a.terminal_guess === true) {
      return [
        finding(
          inv,
          cs,
          "violation",
          "Terminal outcome was guessed without published rule or reconciliation.",
          [ev.seq],
          basis(ctx),
        ),
      ];
    }
  }

  return [
    finding(
      inv,
      cs === "not_declared" ? "declared" : cs,
      "supported",
      has_published_rules
        ? "Terminal races resolved via published rules and/or reconciliation."
        : "No ambiguous/wrong terminal race observed.",
      [],
      basis(ctx),
    ),
  ];
};
