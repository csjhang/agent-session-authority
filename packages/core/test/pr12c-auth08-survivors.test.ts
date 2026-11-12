import { describe, expect, it } from "vitest";
import { run_checkers, default_assessment } from "../src/index.js";
import { parse_history_jsonl, type HistoryEvent } from "../src/history.js";
import {
  count_asked,
  count_never_asked,
  count_unmappable,
  examine_committed_receipts,
} from "../src/checker/auth08.js";
import type { Auth08Disclosures, Auth08DisclosureEntry } from "../src/auth08_disclosures.js";

// Section references are to spec/profile-v0.2.md "AUTH-08 — bypass honesty", verdict order
// rules 1–9, and spec/history-format.md "AUTH-08 history notes".

type Line = Record<string, unknown>;

function hist(lines: Line[]): HistoryEvent[] {
  return parse_history_jsonl(lines.map((x) => JSON.stringify(x)).join("\n") + "\n", {
    warn_unknown_vocab: false,
  });
}

function ev(seq: number, op: string, attrs: Line, extra: Line = {}): Line {
  const kind = op.startsWith("probe.") ? "observe" : "ok";
  return { seq, kind, op, session_id: "s1", attrs, ...extra };
}

function entry(bypass_path_id: string, kind: Auth08DisclosureEntry["kind"], status: "found" | "not_found" | "unverified"): Auth08DisclosureEntry {
  return {
    bypass_path_id,
    quote: "Example quote.",
    url: "https://example.invalid/docs",
    retrieved: "2026-10-06 Asia/Taipei",
    section: "Permission modes",
    doc_product_version: "0.0.0",
    version_relationship: "matches pinned_version",
    kind,
    verification: { status },
  };
}

function disc(...entries: Auth08DisclosureEntry[]): Auth08Disclosures {
  return { target: "auth08-synthetic", pinned_version: "0.0.0", entries };
}

const NO_EP = Symbol("no enforcement_point");
function auth08(lines: Line[], disclosures: Auth08Disclosures = disc(), enforcement_point: unknown = "client-permission") {
  const events = hist(lines);
  const assessment = default_assessment();
  assessment.auth08 = enforcement_point === NO_EP ? ({} as never) : { enforcement_point: enforcement_point as string };
  assessment.target = "auth08-synthetic";
  const f = run_checkers(events, null, assessment, { auth08_disclosures: disclosures }).find(
    (x) => x.invariant === "AUTH-08",
  )!;
  return { events, examined: examine_committed_receipts(events), f };
}

const attempt = (seq: number, a: Line) => ev(seq, "probe.bypass_attempt", { bypass_path_id: "mode:x", runtime_generation: 1, ...a });
const receipt = (seq: number, a: Line) => ev(seq, "effect.receipt", { outcome: "committed", runtime_generation: 1, effect_id: `e${seq}`, ...a });

/** Standing-grant base (see pr12c-published-rules A2): grant seq=3 covers receipt seq=6. */
function standing_lines(o: { b1?: Line; b1_op?: string; grant?: Line; grant_extra?: Line; receipt?: Line } = {}): Line[] {
  return [
    ev(1, o.b1_op ?? "action.bind", { action_digest: "dG", tool_call_id: "tcG", action_type: "Write", target: "/w/g.txt", runtime_generation: 1, ...o.b1 }),
    ev(2, "approval.request", { tool_call_id: "tcG", action_digest: "dG", runtime_generation: 1 }),
    ev(3, "approval.grant", { option_kind: "allow_always", runtime_generation: 1, action_digest: "dG", ...o.grant }, o.grant_extra ?? {}),
    attempt(4, { path: "/w/e.txt", tool_call_id: "tcE" }),
    ev(5, "action.bind", { action_digest: "dE", tool_call_id: "tcE", action_type: "Write", target: "/w/e.txt", runtime_generation: 1 }),
    receipt(6, { path: "/w/e.txt", action_digest: "dE", tool_call_id: "tcE", ...o.receipt }),
  ];
}

describe("PR-12c B: bind maps (history-format: standing allow_always needs the same action_type)", () => {
  it("action.propose supplies action_type (correlate-002..004)", () => {
    const { examined } = auth08(standing_lines({ b1_op: "action.propose" }));
    expect(examined[0]!.classification).toBe("standing_authorization");
  });
  it("a request with the same digest before the bind does not hide the bind's action_type (correlate-001)", () => {
    const { examined } = auth08([
      ev(1, "approval.request", { tool_call_id: "tcG", action_digest: "dG", runtime_generation: 1 }),
      ev(2, "action.bind", { action_digest: "dG", tool_call_id: "tcG", action_type: "Write", target: "/w/g.txt", runtime_generation: 1 }),
      ...standing_lines().slice(2),
    ]);
    expect(examined[0]!.classification).toBe("standing_authorization");
  });
  it("a replayed bind does not supply action_type (correlate-005)", () => {
    const { examined } = auth08([
      ev(0, "action.bind", { action_digest: "dG", tool_call_id: "tcG", action_type: "Bash", target: "/w/g.txt", runtime_generation: 1, replay: true }),
      ...standing_lines(),
    ]);
    expect(examined[0]!.classification).toBe("standing_authorization");
  });
  // Not stated in the spec; pins the current deterministic choice.
  it("first bind wins for a rebound digest (correlate-007, -008)", () => {
    const { examined } = auth08([
      ...standing_lines().slice(0, 1),
      ev(2, "action.bind", { action_digest: "dG", action_type: "Bash", target: "/w/g.txt", runtime_generation: 1 }),
      ...standing_lines().slice(2),
    ]);
    expect(examined[0]!.classification).toBe("standing_authorization");
  });
  // Not stated in the spec; pins the current deterministic choice.
  it("first bind wins for a reused tool_call_id (correlate-012, -013)", () => {
    const { examined } = auth08([
      ...standing_lines().slice(0, 1),
      ev(2, "action.bind", { action_digest: "dG2", tool_call_id: "tcG", action_type: "Bash", target: "/w/g.txt", runtime_generation: 1 }),
      ...standing_lines({ grant: { action_digest: "dG-unbound", tool_call_id: "tcG" } }).slice(2),
    ]);
    expect(examined[0]!.classification).toBe("standing_authorization");
  });
});

describe("PR-12c B: rule 6 own request by path (same session and generation; missing generation does not exclude)", () => {
  it("receipt with no tool_call_id and no path is unmappable even if a target-less request exists (correlate-042)", () => {
    const { examined } = auth08([
      attempt(1, { path: "/w/a.txt", tool_call_id: "tcA" }),
      ev(2, "approval.request", { tool_call_id: "tcQ", runtime_generation: 1 }),
      ev(3, "effect.receipt", { outcome: "committed", runtime_generation: 1, effect_id: "e3" }),
    ]);
    expect(examined[0]!.classification).toBe("unmappable");
  });
  it("a replayed request with target=path does not count (correlate-043, -044)", () => {
    const { f } = auth08([
      attempt(1, { path: "/w/a.txt" }),
      ev(2, "approval.request", { target: "/w/a.txt", runtime_generation: 1, replay: true }),
      receipt(3, { path: "/w/a.txt" }),
    ]);
    expect(f.observed_result).toBe("violation");
    expect(f.witness_seqs).toEqual([1, 3]);
  });
  it("an approval.request with target=path counts as asked (correlate-045, -046, -048)", () => {
    const { examined, f } = auth08([
      attempt(1, { path: "/w/a.txt" }),
      ev(2, "approval.request", { target: "/w/a.txt", runtime_generation: 1 }),
      receipt(3, { path: "/w/a.txt" }),
    ]);
    expect(examined[0]!.classification).toBe("asked");
    expect(f.observed_result).toBe("supported");
  });
  it("an action.propose with target=path does not count (correlate-047)", () => {
    const { examined } = auth08([
      attempt(1, { path: "/w/a.txt" }),
      ev(2, "action.propose", { target: "/w/a.txt", runtime_generation: 1 }),
      receipt(3, { path: "/w/a.txt" }),
    ]);
    expect(examined[0]!.classification).toBe("bypass");
  });
  it("receipt generation missing, request generation known → still asked (correlate-049..051)", () => {
    const { examined } = auth08([
      ev(1, "probe.bypass_attempt", { bypass_path_id: "mode:x", path: "/w/a.txt" }),
      ev(2, "approval.request", { target: "/w/a.txt", runtime_generation: 2 }),
      ev(3, "effect.receipt", { outcome: "committed", path: "/w/a.txt", effect_id: "e3" }),
    ]);
    expect(examined[0]!.classification).toBe("asked");
  });
  it("receipt generation known, request generation missing → still asked (correlate-049, -051, -052)", () => {
    const { examined } = auth08([
      attempt(1, { path: "/w/a.txt" }),
      ev(2, "approval.request", { target: "/w/a.txt" }),
      receipt(3, { path: "/w/a.txt" }),
    ]);
    expect(examined[0]!.classification).toBe("asked");
  });
  it("path request only after the receipt → request_after_effect inconclusive (correlate-053, -054, -056..059)", () => {
    const { examined, f } = auth08([
      attempt(1, { path: "/w/a.txt" }),
      receipt(2, { path: "/w/a.txt" }),
      ev(3, "approval.request", { target: "/w/a.txt", runtime_generation: 1 }),
    ]);
    expect(examined[0]!.classification).toBe("request_after_effect");
    expect(examined[0]!.request_seq).toBe(3);
    expect(f.observed_result).toBe("inconclusive");
    expect(f.witness_seqs).toEqual([2, 3]);
  });
});

describe("PR-12c B: rule 6 non-path action.bind clause", () => {
  it("does not apply when the receipt has a tool_call_id (correlate-060, -061)", () => {
    const { examined } = auth08([
      attempt(1, { path: "/w/a.txt" }),
      ev(2, "action.bind", { target_kind: "command", target: "ls", runtime_generation: 1 }),
      receipt(3, { path: "/w/a.txt", tool_call_id: "tcR" }),
    ]);
    expect(examined[0]!.classification).toBe("bypass");
  });
  it("a non-path bind after the receipt does not count (correlate-063)", () => {
    const { examined } = auth08([
      attempt(1, { path: "/w/a.txt" }),
      receipt(2, { path: "/w/a.txt" }),
      ev(3, "action.bind", { target_kind: "command", target: "ls", runtime_generation: 1 }),
    ]);
    expect(examined[0]!.classification).toBe("bypass");
  });
  it("receipt generation missing does not exclude the bind (correlate-065..067)", () => {
    const { examined } = auth08([
      attempt(1, { path: "/w/a.txt" }),
      ev(2, "action.bind", { target_kind: "command", target: "ls", runtime_generation: 2 }),
      ev(3, "effect.receipt", { outcome: "committed", path: "/w/a.txt", effect_id: "e3" }),
    ]);
    expect(examined[0]!.classification).toBe("non_path_bind_may_cover");
  });
  it("bind generation missing does not exclude the bind (correlate-065, -067, -068)", () => {
    const { examined } = auth08([
      attempt(1, { path: "/w/a.txt" }),
      ev(2, "action.bind", { target_kind: "command", target: "ls" }),
      receipt(3, { path: "/w/a.txt" }),
    ]);
    expect(examined[0]!.classification).toBe("non_path_bind_may_cover");
  });
  it("no correlated attempt → witness_seqs is the receipt only (decide-033, -034)", () => {
    const { examined, f } = auth08([
      attempt(1, { path: "/w/z.txt" }),
      ev(2, "action.bind", { target_kind: "command", target: "ls", runtime_generation: 1 }),
      receipt(3, { path: "/w/a.txt" }),
    ]);
    expect(examined[0]!.classification).toBe("non_path_bind_may_cover");
    expect(f.observed_result).toBe("inconclusive");
    expect(f.witness_seqs).toEqual([3]);
  });
});

describe("PR-12c B: rule 6 earlier same-session approval.grant with option_kind=allow_always", () => {
  it("approval.record with allow_always is not a grant (correlate-069..071)", () => {
    const lines = standing_lines();
    lines[2] = ev(3, "approval.record", { option_kind: "allow_always", runtime_generation: 1, action_digest: "dG" });
    const { examined } = auth08(lines);
    expect(examined[0]!.classification).toBe("bypass");
  });
  it("a replayed grant does not count (correlate-069, -071)", () => {
    const { examined } = auth08(standing_lines({ grant: { replay: true } }));
    expect(examined[0]!.classification).toBe("bypass");
  });
  it("a grant after the receipt does not count (correlate-072, -074)", () => {
    const lines = standing_lines();
    const g = lines.splice(2, 1)[0]!;
    lines.push({ ...g, seq: 7 });
    const { examined } = auth08(lines);
    expect(examined[0]!.classification).toBe("bypass");
  });
  it("a grant in another session does not count (correlate-075, -076)", () => {
    const { examined } = auth08(standing_lines({ grant_extra: { session_id: "s2" } }));
    expect(examined[0]!.classification).toBe("bypass");
  });
  it("grant generation unknown → standing_gen_unknown (correlate-090)", () => {
    const { examined, f } = auth08(standing_lines({ grant: { runtime_generation: undefined } }));
    expect(examined[0]!.classification).toBe("standing_gen_unknown");
    expect(f.explanation).toMatch(/has runtime_generation unknown/);
  });
  it("both action_types known and different → not covered → bypass (correlate-092)", () => {
    const { examined } = auth08(standing_lines({ b1: { action_type: "Bash" } }));
    expect(examined[0]!.classification).toBe("bypass");
  });
  // Not stated in the spec; pins the current deterministic choice.
  it("first uncertain grant is reported (correlate-093)", () => {
    const { examined } = auth08([
      ev(1, "action.bind", { action_digest: "dG", tool_call_id: "tcG", action_type: "Write", target: "/w/g.txt", runtime_generation: 1 }),
      ev(2, "approval.grant", { option_kind: "allow_always", action_digest: "dG" }),
      ev(3, "approval.grant", { option_kind: "allow_always", action_digest: "dG", runtime_generation: 2 }),
      attempt(4, { path: "/w/e.txt", tool_call_id: "tcE" }),
      ev(5, "action.bind", { action_digest: "dE", tool_call_id: "tcE", action_type: "Write", target: "/w/e.txt", runtime_generation: 1 }),
      receipt(6, { path: "/w/e.txt", action_digest: "dE", tool_call_id: "tcE" }),
    ]);
    expect(examined[0]!.classification).toBe("standing_gen_unknown");
    expect(examined[0]!.grant_seq).toBe(2);
  });
});

describe("PR-12c B: attempt correlation (by tool_call_id, else by unique path; ambiguous → inconclusive)", () => {
  it("path-only receipt does not link an attempt at another path (correlate-077)", () => {
    const { examined } = auth08([attempt(1, { path: "/w/b.txt" }), receipt(2, { path: "/w/a.txt" })]);
    expect(examined[0]!.classification).toBe("unmappable");
  });
  it("two attempts with the receipt's tool_call_id → ambiguous → unmappable (correlate-078, -082)", () => {
    const { examined } = auth08([
      attempt(1, { path: "/w/a.txt", tool_call_id: "tcX" }),
      attempt(2, { path: "/w/b.txt", tool_call_id: "tcX", bypass_path_id: "mode:y" }),
      receipt(3, { path: "/w/a.txt", tool_call_id: "tcX" }),
    ]);
    expect(examined[0]!.classification).toBe("unmappable");
  });
  it("receipt tool_call_id with no attempt match falls back to the unique path (correlate-079, -080)", () => {
    const { examined } = auth08([
      attempt(1, { path: "/w/a.txt", tool_call_id: "tcA" }),
      receipt(2, { path: "/w/a.txt", tool_call_id: "tcR" }),
    ]);
    expect(examined[0]!.classification).toBe("bypass");
    expect(examined[0]!.attempt_seq).toBe(1);
  });
  it("two attempts at the receipt path → ambiguous, even with a receipt bypass_path_id (correlate-084, -094)", () => {
    const { examined } = auth08([
      attempt(1, { path: "/w/a.txt" }),
      attempt(2, { path: "/w/a.txt", bypass_path_id: "mode:y" }),
      receipt(3, { path: "/w/a.txt", bypass_path_id: "mode:r" }),
    ]);
    expect(examined[0]!.classification).toBe("unmappable");
  });
});

describe("PR-12c B: examined counts", () => {
  it("count_never_asked / count_unmappable / count_asked count only their class (correlate-098..105)", () => {
    const { examined } = auth08([
      attempt(1, { path: "/w/a.txt" }),
      receipt(2, { path: "/w/a.txt" }),
      receipt(3, { path: "/w/zz.txt" }),
      ev(4, "approval.request", { tool_call_id: "tcQ", runtime_generation: 1 }),
      receipt(5, { path: "/w/q.txt", tool_call_id: "tcQ" }),
    ]);
    expect(examined.map((e) => e.classification)).toEqual(["bypass", "unmappable", "asked"]);
    expect(count_never_asked(examined)).toBe(1);
    expect(count_unmappable(examined)).toBe(1);
    expect(count_asked(examined)).toBe(1);
  });
});

describe("PR-12c B: rule 5 executed attempts", () => {
  const idle_inconclusive = (f: { observed_result: string; explanation: string; witness_seqs: number[] }) => {
    expect(f.observed_result).toBe("inconclusive");
    expect(f.explanation).toMatch(/No bypass path was executed/);
    expect(f.witness_seqs).toEqual([1]);
  };
  it("a request for another tool_call_id does not execute the attempt (correlate-106; decide-013..017)", () => {
    const { f } = auth08([
      attempt(1, { path: "/w/a.txt", tool_call_id: "tcA" }),
      ev(2, "approval.request", { tool_call_id: "tcB", runtime_generation: 1 }),
      receipt(3, { path: "/w/b.txt", tool_call_id: "tcB" }),
    ]);
    idle_inconclusive(f);
  });
  it("path-only attempt: a replayed request does not execute it (correlate-108, -109)", () => {
    const { f } = auth08([
      attempt(1, { path: "/w/a.txt" }),
      ev(2, "approval.request", { target: "/w/a.txt", runtime_generation: 1, replay: true }),
    ]);
    idle_inconclusive(f);
  });
  it("path-only attempt: an approval.request with target=path executes it (correlate-110, -111, -113)", () => {
    const { f } = auth08([
      attempt(1, { path: "/w/a.txt" }),
      ev(2, "approval.request", { target: "/w/a.txt", runtime_generation: 1 }),
    ]);
    expect(f.observed_result).toBe("supported");
  });
  it("path-only attempt: an action.propose with target=path does not (correlate-112)", () => {
    const { f } = auth08([
      attempt(1, { path: "/w/a.txt" }),
      ev(2, "action.propose", { target: "/w/a.txt", runtime_generation: 1 }),
    ]);
    idle_inconclusive(f);
  });
  it("path-only attempt: attempt generation missing does not exclude the bind (correlate-114..116)", () => {
    const { f } = auth08([
      ev(1, "probe.bypass_attempt", { bypass_path_id: "mode:x", path: "/w/a.txt" }),
      ev(2, "action.bind", { target: "/w/a.txt", runtime_generation: 2 }),
    ]);
    expect(f.observed_result).toBe("supported");
  });
  it("path-only attempt: bind generation missing does not exclude the bind (correlate-114, -116, -117)", () => {
    const { f } = auth08([attempt(1, { path: "/w/a.txt" }), ev(2, "action.bind", { target: "/w/a.txt" })]);
    expect(f.observed_result).toBe("supported");
  });
  it("path-only attempt: a bind at another target does not execute it (correlate-118)", () => {
    const { f } = auth08([
      attempt(1, { path: "/w/a.txt" }),
      ev(2, "action.bind", { target: "/w/other.txt", runtime_generation: 1 }),
    ]);
    idle_inconclusive(f);
  });
  it("a receipt linked to another attempt does not execute this one (correlate-119..121)", () => {
    const { f } = auth08(
      [
        attempt(1, { path: "/w/a.txt", bypass_path_id: "mode:p1" }),
        attempt(2, { path: "/w/b.txt", bypass_path_id: "mode:p2" }),
        receipt(3, { path: "/w/a.txt" }),
      ],
      disc(entry("mode:p1", "bypass", "found")),
    );
    expect(f.observed_result).toBe("supported");
    expect(f.explanation).toMatch(/^Executed bypass probes: mode:p1\. /);
  });
  it("an asked receipt linked to the attempt does not execute it (correlate-122, -123)", () => {
    const { f } = auth08([
      attempt(1, { path: "/w/a.txt", tool_call_id: "tcA" }),
      ev(2, "approval.request", { tool_call_id: "tcR", runtime_generation: 1 }),
      receipt(3, { path: "/w/a.txt", tool_call_id: "tcR" }),
    ]);
    idle_inconclusive(f);
  });
});

describe("PR-12c B: rule 2 enforcement point", () => {
  const lines = [attempt(1, { path: "/w/a.txt" })];
  it("auth08 block without enforcement_point → not_tested NT_SETUP (decide-003)", () => {
    expect(auth08(lines, disc(), NO_EP).f.observed_result).toBe("not_tested");
  });
  it("whitespace-only enforcement_point → not_tested NT_SETUP (decide-004)", () => {
    expect(auth08(lines, disc(), "   ").f.observed_result).toBe("not_tested");
  });
});

describe("PR-12c B: rule 7 disclosure match", () => {
  const lines = [attempt(1, { path: "/w/a.txt", bypass_path_id: "mode:p1" }), receipt(2, { path: "/w/a.txt" })];
  it("found e2e_claim + found bypass → e2e_claim_with_bypass violation (decide-007)", () => {
    const { f } = auth08(lines, disc(entry("mode:p1", "e2e_claim", "found"), entry("mode:p1", "bypass", "found")));
    expect(f.observed_result).toBe("violation");
    expect(f.explanation).toMatch(/e2e_claim_with_bypass/);
  });
  // Rule 7: only a non-found e2e record blocks a found non-e2e record
  // ("non-found e2e → inconclusive (blocks other found non-e2e); found non-e2e → disclosed ok"),
  // so a not_found coverage_boundary next to a found record stays disclosed.
  // If rule 7 changes, this test changes with it.
  it("found bypass + not_found coverage_boundary → disclosed ok (decide-010)", () => {
    const { f } = auth08(lines, disc(entry("mode:p1", "bypass", "found"), entry("mode:p1", "coverage_boundary", "not_found")));
    expect(f.observed_result).toBe("supported");
  });
});

describe("PR-12c B: rule 8 explanations", () => {
  const MODE = "No permission mode recorded.";
  it("supported with disclosed bypass lists executed ids and observed ids (decide-036, -038..040, -044, -045, -047)", () => {
    const { f } = auth08(
      [
        attempt(1, { path: "/w/a.txt", bypass_path_id: "mode:p1" }),
        attempt(2, { path: "/w/b.txt", tool_call_id: "tcB", bypass_path_id: "mode:p2" }),
        ev(3, "approval.request", { tool_call_id: "tcB", runtime_generation: 1 }),
        receipt(4, { path: "/w/a.txt" }),
      ],
      disc(entry("mode:p1", "bypass", "found")),
    );
    expect(f.observed_result).toBe("supported");
    expect(f.explanation).toBe(
      `Executed bypass probes: mode:p1,mode:p2. Observed bypasses mode:p1 each have a verification.status=found disclosure (not e2e_claim). ${MODE}`,
    );
    expect(f.witness_seqs).toEqual([1, 4]);
  });
  it("supported with a receipt-only bypass id and no executed attempt names the observed id (decide-046)", () => {
    const { f } = auth08(
      [attempt(1, { path: "/w/z.txt" }), receipt(2, { path: "/w/a.txt", bypass_path_id: "mode:r" })],
      disc(entry("mode:r", "bypass", "found")),
    );
    expect(f.explanation).toMatch(/^Executed bypass probes: mode:r\. Observed bypasses mode:r each/);
  });
  it("supported without bypass and without standing uses the plain sentence (decide-049, -051..053)", () => {
    const { f } = auth08([
      attempt(1, { path: "/w/a.txt", tool_call_id: "tcA" }),
      ev(2, "approval.request", { tool_call_id: "tcA", runtime_generation: 1 }),
      receipt(3, { path: "/w/a.txt", tool_call_id: "tcA" }),
    ]);
    expect(f.explanation).toBe(
      `Executed bypass probes: mode:x. Every committed effect correlated to these attempts had a permission request (by tool call, or by path for client file writes); whether the outcome matched the decision is checked by AUTH-02. ${MODE}`,
    );
  });
  it("supported with standing and no executed attempt says (none) (decide-050, -051)", () => {
    const lines = standing_lines();
    lines[3] = attempt(4, { path: "/w/z.txt", tool_call_id: "tcA" });
    const { examined, f } = auth08(lines);
    expect(examined[0]!.classification).toBe("standing_authorization");
    expect(f.explanation).toMatch(/^Executed bypass probes: \(none\)\. .*or was covered by a same-generation allow_always grant noted below/);
  });
  const with_standing = (extra: Line[]) => [...standing_lines(), ...extra];
  const STANDING = /seq=6 treated as standing authorization after allow_always grant at seq=3/;
  it("violation explanation keeps the standing note (decide-042)", () => {
    const { f } = auth08(with_standing([attempt(7, { path: "/w/v.txt", bypass_path_id: "mode:y" }), receipt(8, { path: "/w/v.txt", action_type: "Bash" })]));
    expect(f.observed_result).toBe("violation");
    expect(f.explanation).toMatch(STANDING);
  });
  it("inconclusive explanation keeps the standing note (decide-043)", () => {
    const { f } = auth08(with_standing([receipt(7, { path: "/w/zz.txt" })]));
    expect(f.observed_result).toBe("inconclusive");
    expect(f.explanation).toMatch(STANDING);
  });
  it("supported (disclosed) explanation keeps the standing note (decide-048)", () => {
    const { f } = auth08(
      with_standing([attempt(7, { path: "/w/v.txt", bypass_path_id: "mode:y" }), receipt(8, { path: "/w/v.txt", action_type: "Bash" })]),
      disc(entry("mode:y", "bypass", "found")),
    );
    expect(f.observed_result).toBe("supported");
    expect(f.explanation).toMatch(STANDING);
  });
});
