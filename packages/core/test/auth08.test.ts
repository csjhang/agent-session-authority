import { describe, expect, it } from "vitest";
import { run_checkers, default_assessment } from "../src/index.js";
import { parse_history_jsonl } from "../src/history.js";

describe("AUTH-08 Bypass honesty checker", () => {
  it("always emits one AUTH-08 finding with result=not_tested", () => {
    const events = parse_history_jsonl(
      '{"seq":1,"kind":"ok","op":"session.attach"}\n',
      { warn_unknown_vocab: false },
    );
    const findings = run_checkers(events, null, default_assessment());
    const auth08 = findings.filter((f) => f.invariant === "AUTH-08");
    expect(auth08).toHaveLength(1);
    expect(auth08[0]!.result).toBe("not_tested");
    expect(auth08[0]!.claim_status).toBe("not_declared");
    expect(auth08[0]!.witness_seqs).toEqual([]);
    expect(auth08[0]!.explanation).toMatch(/AUTH-08 \(Bypass honesty\) has no checker yet/);
    expect(auth08[0]!.explanation).toMatch(/known_bypasses/);
    expect(auth08[0]!.explanation).toMatch(/coverage_boundary/);
  });

  it("run_checkers finding count includes AUTH-08 (12 invariants)", () => {
    const findings = run_checkers([], null, default_assessment());
    const ids = findings.map((f) => f.invariant);
    expect(ids).toContain("AUTH-08");
    expect(ids.filter((id) => id.startsWith("AUTH-")).length).toBe(12);
  });
});
