import type { Checker } from "./index.js";
import { attrs, basis, claim_for, finding, join_unique_sentences, str, observation_guard } from "./index.js";

function uniq_sort(seqs: number[]): number[] {
  return [...new Set(seqs)].sort((a, b) => a - b);
}

type TerminalKind = "cancel" | "complete" | "timeout" | "restart" | "failed" | "unknown";

interface TerminalEvent {
  seq: number;
  kind: TerminalKind;
  subject: string;
  published?: string;
}

const KNOWN_RULE_VALUES = new Set([
  "cancel_wins",
  "complete_wins",
  "timeout_wins",
  "restart_wins",
  "failed_wins",
  "reconcile_required",
]);

function subject_of(a: Record<string, unknown>, ev_session?: string): string | undefined {
  return (
    str(a.effect_id) ??
    str(a.task_id) ??
    str(a.subject_id) ??
    str(a.tool_call_id) ??
    ev_session
  );
}

/**
 * Attribute string → terminal kind. Single string table shared by classify()
 * (terminal ?? terminal_kind ?? status) and explicit_report_finishes_work()
 * (terminal ?? terminal_kind only). "restart" is never attr-derived (fault only).
 */
const ATTR_TERMINAL_KIND: ReadonlyMap<string, TerminalKind> = new Map<string, TerminalKind>([
  ["cancelled", "cancel"],
  ["canceled", "cancel"],
  ["cancel", "cancel"],
  ["completed", "complete"],
  ["complete", "complete"],
  ["committed", "complete"],
  ["success", "complete"],
  ["timeout", "timeout"],
  ["timed_out", "timeout"],
  ["failed", "failed"],
  ["fail", "failed"],
  ["unknown", "unknown"],
  ["orphaned", "unknown"],
]);

/** Attr-reported kinds that finish the call; unknown (and restart) do not. */
const FINISHING_ATTR_KINDS: ReadonlySet<TerminalKind> = new Set<TerminalKind>(["cancel", "complete", "timeout", "failed"]);

function attr_terminal_kind(t: string | undefined): TerminalKind | undefined {
  return t === undefined ? undefined : ATTR_TERMINAL_KIND.get(t);
}

function classify(ev_op: string | undefined, a: Record<string, unknown>, fault?: string): TerminalKind | undefined {
  const by_attr = attr_terminal_kind(str(a.terminal) ?? str(a.terminal_kind) ?? str(a.status));
  if (by_attr !== undefined) return by_attr;

  if (ev_op === "task.cancel" || ev_op === "effect.cancel") return "cancel";
  if (ev_op === "task.complete") return "complete";
  if (ev_op === "task.timeout") return "timeout";
  if (ev_op === "task.reconcile") return undefined;

  if (ev_op === "effect.receipt") {
    const outcome = str(a.outcome);
    if (outcome === "committed") return "complete";
    if (outcome === "failed") return "failed";
    if (outcome === "unknown") return "unknown";
    return undefined;
  }

  if (fault === "runtime.restart" || fault === "runtime.crash") return "restart";
  return undefined;
}

const WIN_RESOLUTION: Record<string, string[]> = {
  cancel_wins: ["cancelled", "canceled", "cancel"],
  complete_wins: ["completed", "complete", "committed", "success"],
  timeout_wins: ["timeout", "timed_out"],
  restart_wins: ["restart", "orphaned", "unknown"],
  failed_wins: ["failed", "fail"],
};


/**
 * Explicitly reported terminal (attrs.terminal / attrs.terminal_kind only — not status,
 * not op-derived) that maps to complete / failed / cancel / timeout.
 * unknown and restart do not finish the call. The event itself is still a terminal event.
 */
function explicit_report_finishes_work(a: Record<string, unknown>): boolean {
  const kind = attr_terminal_kind(str(a.terminal) ?? str(a.terminal_kind));
  return kind !== undefined && FINISHING_ATTR_KINDS.has(kind);
}

function is_terminal_class_event(e: {
  op?: string;
  kind: string;
  fault?: string;
  attrs?: Record<string, unknown>;
}): boolean {
  return (
    e.op === "task.cancel" ||
    e.op === "task.complete" ||
    e.op === "task.timeout" ||
    e.op === "effect.receipt" ||
    e.op === "effect.cancel" ||
    (e.kind === "fault" && (e.fault === "runtime.restart" || e.fault === "runtime.crash"))
  );
}

/**
 * AUTH-07 — deterministic terminal interpretation.
 */
export const check_auth07: Checker = (ctx) => {
  const inv = "AUTH-07";
  const cs = claim_for(ctx, inv);
  const has_terminal_class = ctx.events.some((e) => is_terminal_class_event(e));
  const guard = observation_guard(ctx, inv, has_terminal_class, has_terminal_class);
  if (guard) return guard;

  const profile_rules = (ctx.profile?.terminal_rules ?? {}) as Record<string, string>;
  const has_published_rules = Object.keys(profile_rules).length > 0;

  const terminals = new Map<string, TerminalEvent[]>();
  const reconciles = new Map<string, { seq: number; resolved: string }>();
  const unfinished_by_session = new Map<string, Set<string>>();
  const violations: { text: string; witnesses: number[]; marker?: boolean }[] = [];

  for (const ev of ctx.events) {
    const a = attrs(ev);

    const subj = subject_of(a, ev.session_id);
    if (subj && (ev.op === "effect.dispatch" || ev.op === "task.start" || ev.op === "action.bind")) {
      if (ev.session_id) {
        const set = unfinished_by_session.get(ev.session_id) ?? new Set();
        set.add(subj);
        unfinished_by_session.set(ev.session_id, set);
      }
    }
    if (
      subj &&
      (ev.op === "task.complete" ||
        ev.op === "task.cancel" ||
        ev.op === "task.timeout" ||
        (ev.op === "effect.receipt" &&
          (str(a.outcome) === "committed" || str(a.outcome) === "failed" || str(a.outcome) === "rejected")) ||
        explicit_report_finishes_work(a))
    ) {
      if (ev.session_id) unfinished_by_session.get(ev.session_id)?.delete(subj);
    }

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

    if (
      ev.op === "task.cancel" ||
      ev.op === "task.complete" ||
      ev.op === "task.timeout" ||
      ev.op === "effect.cancel" ||
      a.terminal != null ||
      a.terminal_kind != null ||
      (ev.kind === "fault" && (ev.fault === "runtime.restart" || ev.fault === "runtime.crash")) ||
      (ev.op === "effect.receipt" &&
        (str(a.outcome) === "committed" || str(a.outcome) === "failed" || str(a.outcome) === "unknown"))
    ) {
      if (ev.kind === "fault" && (ev.fault === "runtime.restart" || ev.fault === "runtime.crash") && ev.session_id) {
        const unfinished = unfinished_by_session.get(ev.session_id) ?? new Set();
        for (const u of unfinished) {
          const list = terminals.get(u) ?? [];
          list.push({ seq: ev.seq, kind: "restart", subject: u });
          terminals.set(u, list);
        }
        continue;
      }

      if (ev.kind === "fault" && (ev.fault === "runtime.restart" || ev.fault === "runtime.crash") && !ev.session_id) {
        const subject = subject_of(a, undefined);
        if (!subject) continue;
        const list = terminals.get(subject) ?? [];
        list.push({ seq: ev.seq, kind: "restart", subject });
        terminals.set(subject, list);
        continue;
      }

      const subject = subject_of(a, ev.session_id);
      if (!subject) continue;
      const list = terminals.get(subject) ?? [];
      list.push({
        seq: ev.seq,
        kind,
        subject,
        published: str(a.published_terminal) ?? str(a.terminal),
      });
      terminals.set(subject, list);
    }
  }

  const race_pairs: Array<[TerminalKind, TerminalKind]> = [
    ["cancel", "complete"],
    ["timeout", "complete"],
    ["cancel", "timeout"],
    ["restart", "complete"],
    ["restart", "cancel"],
    ["restart", "timeout"],
    ["failed", "complete"],
    ["failed", "cancel"],
  ];

  for (const [subject, events] of terminals) {
    const kinds = new Set(events.map((e) => e.kind));

    for (const [a, b] of race_pairs) {
      if (!(kinds.has(a) && kinds.has(b))) continue;
      const witnesses = events.filter((e) => e.kind === a || e.kind === b).map((e) => e.seq);
      const rec = reconciles.get(subject);
      const rule_key = `${a}_vs_${b}`;
      const alt_key = `${b}_vs_${a}`;
      const rule = profile_rules[rule_key] ?? profile_rules[alt_key];

      if (!rec && !rule && !has_published_rules) {
        violations.push({
          text: `Ambiguous terminal race (${a} vs ${b}) for ${subject} without published rule or reconciliation.`,
          witnesses: witnesses.sort((x, y) => x - y),
        });
        continue;
      }

      if (!rec && has_published_rules && !rule) {
        violations.push({
          text: `Terminal race (${a} vs ${b}) for ${subject} not covered by published terminal_rules.`,
          witnesses: witnesses.sort((x, y) => x - y),
        });
        continue;
      }

      if (!rec && rule && !KNOWN_RULE_VALUES.has(rule)) {
        // Unknown value = no published rule for that race
        if (has_published_rules) {
          violations.push({
            text: `Terminal race (${a} vs ${b}) for ${subject} not covered by published terminal_rules (unknown rule value ${rule}).`,
            witnesses: witnesses.sort((x, y) => x - y),
          });
        }
        continue;
      }

      if (!rec && rule === "reconcile_required") {
        violations.push({
          text: `Terminal race (${a} vs ${b}) for ${subject} requires reconciliation (reconcile_required) but none was observed.`,
          witnesses: witnesses.sort((x, y) => x - y),
        });
        continue;
      }

      const published = events.map((e) => e.published).filter(Boolean) as string[];
      if (published.includes("completed") && published.includes("cancelled") && !rec) {
        violations.push({
          text: `Conflicting published terminals for ${subject} (completed and cancelled) without reconciliation.`,
          witnesses: witnesses.sort((x, y) => x - y),
        });
      }

      if (rec && rule && rule !== "reconcile_required") {
        const allowed = WIN_RESOLUTION[rule];
        if (allowed && !allowed.some((x) => rec.resolved === x || rec.resolved.startsWith(x))) {
          violations.push({
            text: `Reconciliation resolved to ${rec.resolved} but published rule ${rule_key}=${rule}.`,
            witnesses: [...witnesses, rec.seq].sort((x, y) => x - y),
          });
        }
      }
    }

    if (
      events.some((e) => e.kind === "unknown") &&
      events.some((e) => e.kind === "complete" || e.kind === "cancel") &&
      !reconciles.has(subject)
    ) {
      violations.push({
        text: `Unknown terminal coexists with another terminal for ${subject} without reconciliation.`,
        witnesses: events.map((e) => e.seq).sort((x, y) => x - y),
      });
    }
  }

  for (const ev of ctx.events) {
    const a = attrs(ev);
    if (a.ambiguous_terminal === true || a.terminal_guess === true) {
      violations.push({
        text: "test-injected marker ambiguous_terminal/terminal_guess: Terminal outcome was guessed without published rule or reconciliation.",
        witnesses: [ev.seq],
        marker: true,
      });
    }
  }

  if (violations.length > 0) {
    const witnesses = [...new Set(violations.flatMap((v) => v.witnesses))].sort((a, b) => a - b);
    const marker_note = violations.some((v) => v.marker) ? " Includes test-injected marker." : "";
    return [
      finding(
        inv,
        cs,
        "violation",
        join_unique_sentences(violations.map((v) => v.text)) + marker_note,
        witnesses,
        basis(ctx),
      ),
    ];
  }

  const examined: TerminalEvent[][] = [];
  for (const events of terminals.values()) {
    const examined_contention =
      events.length >= 2 || events.some((e) => e.kind === "restart");
    if (examined_contention) examined.push(events);
  }

  if (examined.length === 0) {
    return [
      finding(
        inv,
        cs,
        "inconclusive",
        "no terminal contention examined",
        [],
        basis(ctx),
      ),
    ];
  }

  const terminal_witnesses = uniq_sort(examined.flatMap((events) => events.map((e) => e.seq)));
  return [
    finding(
      inv,
      cs,
      "supported",
      has_published_rules
        ? "Terminal races resolved via published rules and/or reconciliation."
        : "No ambiguous/wrong terminal race observed.",
      terminal_witnesses,
      basis(ctx),
    ),
  ];
};
