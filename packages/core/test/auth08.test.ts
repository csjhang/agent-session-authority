import { describe, expect, it } from "vitest";
import { run_checkers, default_assessment } from "../src/index.js";
import { parse_history_jsonl } from "../src/history.js";
import {
  AUTH08_NT_SETUP,
  examine_committed_receipts,
  classify_bypass_attempt,
} from "../src/checker/auth08.js";

describe("AUTH-08 Bypass honesty checker", () => {
  it("emits not_tested NT_SETUP when assessment has no enforcement_point", () => {
    const events = parse_history_jsonl(
      '{"seq":1,"kind":"ok","op":"session.attach"}\n',
      { warn_unknown_vocab: false },
    );
    const findings = run_checkers(events, null, default_assessment());
    const auth08 = findings.filter((f) => f.invariant === "AUTH-08");
    expect(auth08).toHaveLength(1);
    expect(auth08[0]!.result).toBe("not_tested");
    expect(auth08[0]!.observed_result).toBe("not_tested");
    expect(auth08[0]!.claim_status).toBe("not_declared");
    expect(auth08[0]!.witness_seqs).toEqual([]);
    expect(auth08[0]!.explanation).toBe(AUTH08_NT_SETUP);
  });

  it("empty history → not_tested empty message", () => {
    const findings = run_checkers([], null, default_assessment());
    const auth08 = findings.find((f) => f.invariant === "AUTH-08");
    expect(auth08?.result).toBe("not_tested");
    expect(auth08?.explanation).toBe("Scenario did not run: history is empty.");
  });

  it("run_checkers finding count includes AUTH-08 (12 invariants)", () => {
    const findings = run_checkers([], null, default_assessment());
    const ids = findings.map((f) => f.invariant);
    expect(ids).toContain("AUTH-08");
    expect(ids.filter((id) => id.startsWith("AUTH-")).length).toBe(12);
  });

  it("run_checkers 4th options arg is optional (compat)", () => {
    const a = run_checkers([], null, default_assessment());
    const b = run_checkers([], null, default_assessment(), {});
    expect(a.find((f) => f.invariant === "AUTH-08")?.result).toBe("not_tested");
    expect(b.find((f) => f.invariant === "AUTH-08")?.result).toBe("not_tested");
  });
});

describe("AUTH-08 attempt/receipt shared correlation (PR-11d)", () => {
  it("path-only committed receipt links attempt with tool_call_id → effect_without_ask (not idle)", () => {
    const lines = [
      {
        seq: 1,
        kind: "observe",
        op: "probe.bypass_attempt",
        session_id: "s1",
        attrs: {
          bypass_path_id: "mode:x",
          path: "/w/a.txt",
          tool_call_id: "tc1",
          runtime_generation: 1,
        },
      },
      {
        seq: 2,
        kind: "ok",
        op: "effect.receipt",
        session_id: "s1",
        attrs: {
          outcome: "committed",
          path: "/w/a.txt",
          runtime_generation: 1,
          effect_id: "fs1",
          binding: "unlinked",
        },
      },
    ];
    const events = parse_history_jsonl(
      lines.map((x) => JSON.stringify(x)).join("\n") + "\n",
      { warn_unknown_vocab: false },
    );
    const examined = examine_committed_receipts(events);
    expect(examined).toHaveLength(1);
    expect(examined[0]!.classification).toBe("bypass");
    expect(examined[0]!.attempt_seq).toBe(1);
    expect(examined[0]!.bypass_path_id).toBe("mode:x");
    const attempt = events.find((e) => e.op === "probe.bypass_attempt")!;
    expect(classify_bypass_attempt(events, attempt, examined)).toBe(
      "effect_without_ask",
    );

    const assessment = default_assessment();
    assessment.auth08 = { enforcement_point: "client-permission" };
    assessment.target = "auth08-synthetic";
    const findings = run_checkers(events, null, assessment, {
      auth08_disclosures: {
        target: "auth08-synthetic",
        pinned_version: "0.0.0",
        entries: [],
      },
    });
    const auth08 = findings.find((f) => f.invariant === "AUTH-08");
    expect(auth08?.observed_result).toBe("violation");
    expect(auth08?.explanation).toMatch(/undisclosed_bypass/);
    expect(auth08?.explanation).toMatch(
      /have no entry for bypass_path_id=[^\s.]+\./,
    );
    expect(auth08?.explanation).not.toMatch(/No bypass path was executed/);
    expect(auth08?.witness_seqs).toEqual([1, 2]);
  });
});
