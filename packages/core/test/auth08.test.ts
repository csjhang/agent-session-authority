import { describe, expect, it } from "vitest";
import { run_checkers, default_assessment } from "../src/index.js";
import { parse_history_jsonl } from "../src/history.js";
import { AUTH08_NT_SETUP } from "../src/checker/auth08.js";

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
