import { describe, expect, it } from "vitest";
import {
  HistoryValidationError,
  parse_history_jsonl,
  serialize_history_jsonl,
  type HistoryEvent,
} from "../src/history.js";
import { default_assessment } from "../src/assessment.js";
import { run_checkers } from "../src/index.js";
import { build_report } from "../src/report.js";

const valid_jsonl = [
  '{"seq":1,"kind":"observe","op":"generation.observe","attrs":{"runtime_generation":1}}',
  '{"seq":2,"kind":"ok","op":"lease.acquire","actor_id":"c1","attrs":{"scope_id":"ws","holder":"c1","fence_epoch":1}}',
  '{"seq":3,"kind":"fault","fault":"runtime.restart","note":"bounce"}',
].join("\n");

describe("Day 3-4 history parse / validate", () => {
  it("parses valid JSONL in order without sorting", () => {
    const events = parse_history_jsonl(valid_jsonl, { warn_unknown_vocab: false });
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(events[0]!.kind).toBe("observe");
    expect(events[1]!.op).toBe("lease.acquire");
    expect(events[2]!.fault).toBe("runtime.restart");
  });

  it("rejects bad JSON", () => {
    expect(() => parse_history_jsonl("{not json}\n")).toThrow(HistoryValidationError);
    expect(() => parse_history_jsonl("{not json}\n")).toThrow(/parse error/);
  });

  it("rejects missing seq", () => {
    expect(() =>
      parse_history_jsonl('{"kind":"ok","op":"lease.acquire"}\n'),
    ).toThrow(/missing seq/);
  });

  it("rejects non-number seq", () => {
    expect(() =>
      parse_history_jsonl('{"seq":"1","kind":"ok"}\n'),
    ).toThrow(/seq must be a finite number/);
  });

  it("rejects unknown / invalid kind", () => {
    expect(() =>
      parse_history_jsonl('{"seq":1,"kind":"success"}\n'),
    ).toThrow(/invalid kind/);
  });

  it("rejects non-monotonic seq (does not silently sort)", () => {
    const text = [
      '{"seq":2,"kind":"ok","op":"lease.acquire"}',
      '{"seq":1,"kind":"observe","op":"generation.observe"}',
    ].join("\n");
    expect(() => parse_history_jsonl(text)).toThrow(/non-monotonic/);
  });

  it("rejects duplicate seq", () => {
   const text = [
      '{"seq":1,"kind":"ok","op":"lease.acquire"}',
      '{"seq":1,"kind":"ok","op":"lease.release"}',
    ].join("\n");
    expect(() => parse_history_jsonl(text)).toThrow(/duplicate seq/);
  });

  it("allows unknown op with warn (extension policy)", () => {
    const warnings: string[] = [];
    const events = parse_history_jsonl(
      '{"seq":1,"kind":"ok","op":"custom.extension"}\n',
      { warn: (m) => warnings.push(m) },
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.op).toBe("custom.extension");
    expect(warnings.some((w) => w.includes("unknown op"))).toBe(true);
  });

  it("serialize_history_jsonl round-trips", () => {
    const events = parse_history_jsonl(valid_jsonl, { warn_unknown_vocab: false });
    const again = parse_history_jsonl(serialize_history_jsonl(events), {
      warn_unknown_vocab: false,
    });
    expect(again).toEqual(events);
  });

  it("skips blank lines and # comments", () => {
    const text = `#header\n\n${valid_jsonl}\n# trailer\n`;
    const events = parse_history_jsonl(text, { warn_unknown_vocab: false });
    expect(events).toHaveLength(3);
  });
});

describe("Day 3-4 report: claim_status vs result", () => {
  it("AUTH-02/04/07 are measured; claim_status stays a distinct axis", () => {
    const profile = {
      profile_version: "0.2",
      target: "synthetic-day34",
      claimed_invariants: ["AUTH-01"],
    };
    const events: HistoryEvent[] = parse_history_jsonl(valid_jsonl, {
      warn_unknown_vocab: false,
    });
    const assessment = default_assessment();
    assessment.target = "synthetic-day34";
    assessment.test_basis = "synthetic_fixture";

    const findings = run_checkers(events, profile, assessment);
    const report = build_report(findings, assessment, profile);

    for (const inv of ["AUTH-02", "AUTH-04", "AUTH-07"]) {
      const f = findings.find((x) => x.invariant === inv);
      expect(f, inv).toBeTruthy();
      expect(f!.result).not.toBe("not_tested");
      expect(f!.result).not.toBe("not_declared");
      expect(report.capability_vector[inv]).toBe(f!.result);
      expect(report.claim_status_vector[inv]).toBe(f!.claim_status);
    }
  });

  it("when profile claims AUTH-02/04/07, claim_status=declared and result is measured", () => {
    const claiming = {
      profile_version: "0.2",
      target: "claims-auth02",
      claimed_invariants: ["AUTH-02", "AUTH-04", "AUTH-07"],
    };
    const events = parse_history_jsonl(valid_jsonl, { warn_unknown_vocab: false });
    const assessment = default_assessment();
    const findings = run_checkers(events, claiming, assessment);
    for (const inv of ["AUTH-02", "AUTH-04", "AUTH-07"]) {
      const f = findings.find((x) => x.invariant === inv)!;
      expect(f!.result).not.toBe("not_tested");
      expect(f!.claim_status).toBe("declared");
    }
  });
});
