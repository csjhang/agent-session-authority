import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run_checkers, default_assessment } from "../src/index.js";
import { parse_history_jsonl, type HistoryEvent } from "../src/history.js";
import { examine_committed_receipts } from "../src/checker/auth08.js";
import { load_auth08_disclosures, type Auth08Disclosures } from "../src/auth08_disclosures.js";
import { run_cli } from "../src/cli_run.js";

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

const NO_DISCLOSURES: Auth08Disclosures = {
  target: "auth08-synthetic",
  pinned_version: "0.0.0",
  entries: [],
};

function auth08(lines: Line[], disclosures: Auth08Disclosures = NO_DISCLOSURES) {
  const events = hist(lines);
  const assessment = default_assessment();
  assessment.auth08 = { enforcement_point: "client-permission" };
  assessment.target = "auth08-synthetic";
  const f = run_checkers(events, null, assessment, { auth08_disclosures: disclosures }).find(
    (x) => x.invariant === "AUTH-08",
  )!;
  return { events, examined: examine_committed_receipts(events), f };
}

describe("PR-12c A1: AUTH-08 rule 6 looks up the receipt's own tool_call_id first", () => {
  // spec/profile-v0.2.md AUTH-08 verdict rule 6: "find this effect's own permission request:
  // by the receipt's tool_call_id; if the receipt has none ... by that attempt's tool_call_id".
  it("receipt tool_call_id request before the effect wins over the attempt's later request", () => {
    const { examined, f } = auth08([
      ev(1, "probe.bypass_attempt", { bypass_path_id: "mode:x", path: "/w/a.txt", tool_call_id: "tcA", runtime_generation: 1 }),
      ev(2, "approval.request", { tool_call_id: "tcR", runtime_generation: 1 }),
      ev(3, "effect.receipt", { outcome: "committed", tool_call_id: "tcR", path: "/w/a.txt", runtime_generation: 1, effect_id: "e1" }),
      ev(4, "approval.request", { tool_call_id: "tcA", runtime_generation: 1 }),
    ]);
    expect(examined).toHaveLength(1);
    expect(examined[0]!.classification).toBe("asked");
    expect(examined[0]!.request_seq).toBe(2);
    expect(examined[0]!.attempt_seq).toBe(1);
    expect(f.observed_result).toBe("supported");
    expect(f.witness_seqs).toEqual([1, 3]);
  });
});

/**
 * Standing-grant base history: grant at seq=3, attempt at seq=4, the effect's bind at seq=5,
 * committed receipt at seq=6. No approval.request for the effect itself.
 */
function standing(grant: Line, receipt: Line, prefix: Line[] = []) {
  return auth08([
    ...prefix,
    ev(1, "action.bind", { action_digest: "dG", tool_call_id: "tcG", action_type: "Write", target: "/w/g.txt", runtime_generation: 1 }),
    ev(2, "approval.request", { tool_call_id: "tcG", action_digest: "dG", runtime_generation: 1 }),
    ev(3, "approval.grant", { option_kind: "allow_always", runtime_generation: 1, ...grant }),
    ev(4, "probe.bypass_attempt", { bypass_path_id: "mode:x", path: "/w/e.txt", tool_call_id: "tcE", runtime_generation: 1 }),
    ev(5, "action.bind", { action_digest: "dE", tool_call_id: "tcE", action_type: "Write", target: "/w/e.txt", runtime_generation: 1 }),
    ev(6, "effect.receipt", { outcome: "committed", path: "/w/e.txt", runtime_generation: 1, effect_id: "e1", ...receipt }),
  ]);
}

describe("PR-12c A2: AUTH-08 allow_always action_type lookup (digest, then tool_call_id)", () => {
  // spec/history-format.md AUTH-08 history notes: "Standing allow_always covers an effect only
  // within the same runtime_generation and the same action_type (both known)."
  it("grant resolvable only by action_digest → covered (standing authorization)", () => {
    const { examined, f } = standing({ action_digest: "dG" }, { action_digest: "dE", tool_call_id: "tcE" });
    expect(examined[0]!.classification).toBe("standing_authorization");
    expect(examined[0]!.grant_seq).toBe(3);
    expect(f.observed_result).toBe("supported");
  });

  it("grant resolvable only by tool_call_id (its digest is unbound) → covered", () => {
    const { examined, f } = standing({ action_digest: "dG-unbound", tool_call_id: "tcG" }, { action_digest: "dE", tool_call_id: "tcE" });
    expect(examined[0]!.classification).toBe("standing_authorization");
    expect(f.observed_result).toBe("supported");
  });

  it("effect resolvable only by action_digest (receipt has no tool_call_id) → covered", () => {
    const { examined, f } = standing({ action_digest: "dG" }, { action_digest: "dE" });
    expect(examined[0]!.classification).toBe("standing_authorization");
    expect(f.observed_result).toBe("supported");
  });

  it("effect resolvable only by tool_call_id (its digest is unbound) → covered", () => {
    const { examined, f } = standing({ action_digest: "dG" }, { action_digest: "dE-unbound", tool_call_id: "tcE" });
    expect(examined[0]!.classification).toBe("standing_authorization");
    expect(f.observed_result).toBe("supported");
  });

  it("grant with neither key bound → action_type unknown → standing_unscoped inconclusive", () => {
    const { examined, f } = standing({ action_digest: "dG-unbound", tool_call_id: "tcG-unbound" }, { action_digest: "dE", tool_call_id: "tcE" });
    expect(examined[0]!.classification).toBe("standing_unscoped");
    expect(f.observed_result).toBe("inconclusive");
    expect(f.witness_seqs).toEqual([3, 6]);
  });
});

describe("PR-12c A3: AUTH-08 replayed committed receipts are skipped", () => {
  // spec/profile-v0.2.md AUTH-08 verdict rule 6: "For each committed non-replay receipt".
  const lines = [
    ev(1, "probe.bypass_attempt", { bypass_path_id: "mode:x", path: "/w/a.txt", tool_call_id: "tcA", runtime_generation: 1 }),
    ev(2, "effect.receipt", { outcome: "committed", tool_call_id: "tcA", path: "/w/a.txt", runtime_generation: 1, effect_id: "e1", replay: true }),
  ];
  it("a replayed committed receipt is not examined and is not an effect without a request", () => {
    const { examined, f } = auth08(lines);
    expect(examined).toHaveLength(0);
    expect(f.observed_result).toBe("inconclusive");
    expect(f.explanation).toMatch(/No bypass path was executed/);
    expect(f.witness_seqs).toEqual([1]);
  });
});

function auth02(lines: Line[]) {
  const events = hist(lines);
  const assessment = default_assessment();
  assessment.test_basis = "synthetic_fixture";
  return run_checkers(events, null, assessment).find((x) => x.invariant === "AUTH-02")!;
}

describe("PR-12c A4: AUTH-02 committed receipts are deduplicated by effect_id", () => {
  // spec/profile-v0.2.md AUTH-02: "Evaluated per effect.receipt with outcome=committed
  // (deduplicated by effect_id)."
  it("a second committed receipt with the same effect_id is not counted again", () => {
    const f = auth02([
      ev(1, "action.bind", { action_digest: "d1", action_type: "Write", target: "/w/a.txt" }),
      ev(2, "approval.grant", { action_digest: "d1" }),
      ev(3, "effect.receipt", { outcome: "committed", action_digest: "d1", effect_id: "e1" }),
      ev(4, "effect.receipt", { outcome: "committed", action_digest: "d1", effect_id: "e1" }),
    ]);
    expect(f.observed_result).toBe("supported");
    expect(f.explanation).toMatch(/runtime_generation not compared for 1 of 1 counted receipt\(s\)/);
    expect(f.witness_seqs).toEqual([2, 3]);
  });
  it("committed receipts without effect_id are each counted", () => {
    const f = auth02([
      ev(1, "action.bind", { action_digest: "d1", action_type: "Write", target: "/w/a.txt" }),
      ev(2, "approval.grant", { action_digest: "d1" }),
      ev(3, "effect.receipt", { outcome: "committed", action_digest: "d1" }),
      ev(4, "effect.receipt", { outcome: "committed", action_digest: "d1" }),
    ]);
    expect(f.observed_result).toBe("supported");
    expect(f.explanation).toMatch(/runtime_generation not compared for 2 of 2 counted receipt\(s\)/);
    expect(f.witness_seqs).toEqual([2, 3, 4]);
  });
});

function auth07(lines: Line[], terminal_rules: Record<string, string>) {
  const events = hist(lines);
  const assessment = default_assessment();
  assessment.test_basis = "synthetic_fixture";
  const profile = { profile_version: "0.2", target: "pr12c-synthetic", claimed_invariants: ["AUTH-07"], terminal_rules };
  return run_checkers(events, profile as never, assessment).find((x) => x.invariant === "AUTH-07")!;
}

describe("PR-12c A5: AUTH-07 reconciliation must follow the published *_wins rule", () => {
  // spec/profile-v0.2.md AUTH-07 row: "A reconciliation whose resolved terminal contradicts
  // the published `*_wins` rule for that race is a violation."
  it("cancel_wins published, reconciliation resolves to completed → violation", () => {
    const f = auth07(
      [
        ev(1, "task.cancel", { task_id: "t1" }),
        ev(2, "task.reconcile", { task_id: "t1", resolved_terminal: "completed" }),
        ev(3, "task.complete", { task_id: "t1" }),
      ],
      { cancel_vs_complete: "cancel_wins" },
    );
    expect(f.observed_result).toBe("violation");
    expect(f.explanation).toBe("Reconciliation resolved to completed but published rule cancel_vs_complete=cancel_wins.");
    expect(f.witness_seqs).toEqual([1, 2, 3]);
  });
  it("cancel_wins published, reconciliation resolves to cancelled → supported", () => {
    const f = auth07(
      [
        ev(1, "task.cancel", { task_id: "t1" }),
        ev(2, "task.reconcile", { task_id: "t1", resolved_terminal: "cancelled" }),
        ev(3, "task.complete", { task_id: "t1" }),
      ],
      { cancel_vs_complete: "cancel_wins" },
    );
    expect(f.observed_result).toBe("supported");
  });
  // The spec does not define which resolved values match a *_wins rule, so this
  // test pins the current matching (resolved.startsWith(allowed value)).
  it("cancel_wins published, reconciliation resolves to a cancelled_* value → supported (prefix match)", () => {
    const f = auth07(
      [
        ev(1, "task.cancel", { task_id: "t1" }),
        ev(2, "task.reconcile", { task_id: "t1", resolved_terminal: "cancelled_by_user" }),
        ev(3, "task.complete", { task_id: "t1" }),
      ],
      { cancel_vs_complete: "cancel_wins" },
    );
    expect(f.observed_result).toBe("supported");
  });
});

const repo_root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
function capture(argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = run_cli(argv, { cwd: repo_root, stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) });
  return { code, stdout, stderr };
}

describe("PR-12c A6: disclosure loader errors (README exit-code table: 2 = missing file, JSON parse failure)", () => {
  const hist_path = path.join(repo_root, "corpus/auth08/violate-undisclosed.jsonl");
  const assessment = path.join(repo_root, "corpus/auth08/default.assessment.json");
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "asa-pr12c-"));

  it("missing disclosures file → loader error 'not found'; asa check --disclosures exits 2", () => {
    const missing = path.join(tmp(), "absent.json");
    expect(() => load_auth08_disclosures(missing, { target: "auth08-synthetic" })).toThrow(/disclosures file not found/);
    const r = capture(["node", "asa", "check", hist_path, "--assessment", assessment, "--disclosures", missing]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/disclosures file not found/);
  });

  it("invalid JSON → loader error 'JSON parse failed'; asa check --disclosures exits 2", () => {
    const bad = path.join(tmp(), "bad.json");
    fs.writeFileSync(bad, "{ not json", "utf8");
    expect(() => load_auth08_disclosures(bad, { target: "auth08-synthetic" })).toThrow(/disclosures JSON parse failed/);
    const r = capture(["node", "asa", "check", hist_path, "--assessment", assessment, "--disclosures", bad]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/disclosures JSON parse failed/);
  });
});
