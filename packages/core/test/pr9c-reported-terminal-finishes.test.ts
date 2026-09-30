/**
 * PR-9c: an explicitly reported terminal (attrs.terminal / attrs.terminal_kind
 * mapping to complete/failed/cancel/timeout) finishes the call the same way
 * task.complete / effect.receipt committed|failed|rejected does. A later
 * same-session restart does not pair with that call.
 *
 * Agent reports use the PR-8c shape: attrs.terminal plus
 * field_provenance.terminal = "target".
 */
import { describe, expect, it } from "vitest";
import { default_assessment } from "../src/assessment.js";
import { parse_history_jsonl } from "../src/history.js";
import { run_checkers } from "../src/index.js";

const SID = "sess-pr9c";
const CALL = "call-pr9c";

function line(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

function bind(seq: number) {
  return line({
    seq,
    kind: "invoke",
    op: "action.bind",
    session_id: SID,
    attrs: { tool_call_id: CALL },
  });
}

/** PR-8c agent report. Pass null to omit the report. */
function report(seq: number, terminal: string | null) {
  if (terminal == null) return null;
  return line({
    seq,
    kind: "observe",
    op: "session.attach",
    session_id: SID,
    attrs: {
      tool_call_id: CALL,
      terminal,
      field_provenance: { terminal: "target" },
    },
  });
}

function restart(seq: number) {
  return line({
    seq,
    kind: "fault",
    fault: "runtime.restart",
    session_id: SID,
    note: "runtime restart",
    attrs: {},
  });
}

function receipt(seq: number, outcome: "committed" | "unknown") {
  return line({
    seq,
    kind: "ok",
    op: "effect.receipt",
    session_id: SID,
    attrs: { tool_call_id: CALL, effect_id: CALL, outcome },
  });
}

function auth07(lines: Array<string | null>) {
  const history = parse_history_jsonl(
    lines.filter((l): l is string => l != null).join("\n"),
    { warn_unknown_vocab: false },
  );
  const assessment = default_assessment();
  assessment.test_basis = "synthetic_fixture";
  const profile = {
    profile_version: "0.2",
    target: "pr9c-synthetic",
    claimed_invariants: ["AUTH-07"],
  };
  const f = run_checkers(history, profile, assessment).find((x) => x.invariant === "AUTH-07");
  expect(f, "AUTH-07 finding").toBeTruthy();
  return f!;
}

describe("PR-9c reported terminal finishes the call", () => {
  it("A. agent reports completed → restart → receipt committed is supported, and witness_seqs omit the restart", () => {
    const restart_seq = 3;
    const f = auth07([
      bind(1),
      report(2, "completed"),
      restart(restart_seq),
      receipt(4, "committed"),
    ]);
    expect(f.observed_result).toBe("supported");
    expect(f.result).toBe("supported");
    expect(f.witness_seqs).not.toContain(restart_seq);
    expect(f.witness_seqs).toEqual([2, 4]);
  });

  it("B. agent reports completed → receipt committed → restart is supported", () => {
    const f = auth07([
      bind(1),
      report(2, "completed"),
      receipt(3, "committed"),
      restart(4),
    ]);
    expect(f.observed_result).toBe("supported");
    expect(f.result).toBe("supported");
    expect(f.witness_seqs).not.toContain(4);
    expect(f.witness_seqs).toEqual([2, 3]);
  });

  it("C. no agent report → restart → receipt committed is a restart vs complete violation", () => {
    const f = auth07([
      bind(1),
      restart(2),
      receipt(3, "committed"),
    ]);
    expect(f.observed_result).toBe("violation");
    expect(f.result).toBe("violation");
    expect(f.explanation).toContain("restart vs complete");
    expect(f.witness_seqs).toContain(2);
  });

  it("D. agent reports failed → restart → receipt committed is a failed vs complete violation", () => {
    const restart_seq = 3;
    const f = auth07([
      bind(1),
      report(2, "failed"),
      restart(restart_seq),
      receipt(4, "committed"),
    ]);
    expect(f.observed_result).toBe("violation");
    expect(f.result).toBe("violation");
    expect(f.explanation).toContain("failed vs complete");
    expect(f.explanation).not.toContain("restart vs complete");
    expect(f.witness_seqs).not.toContain(restart_seq);
  });

  it("E. agent reports completed → restart → receipt unknown: unknown coexists", () => {
    const restart_seq = 3;
    const f = auth07([
      bind(1),
      report(2, "completed"),
      restart(restart_seq),
      receipt(4, "unknown"),
    ]);
    expect(f.observed_result).toBe("violation");
    expect(f.result).toBe("violation");
    expect(f.explanation).toContain("Unknown terminal coexists");
    expect(f.witness_seqs).not.toContain(restart_seq);
  });

  it("F. no agent report → restart → receipt unknown is supported", () => {
    const f = auth07([
      bind(1),
      restart(2),
      receipt(3, "unknown"),
    ]);
    expect(f.observed_result).toBe("supported");
    expect(f.result).toBe("supported");
    expect(f.witness_seqs).toEqual([2, 3]);
  });
});
