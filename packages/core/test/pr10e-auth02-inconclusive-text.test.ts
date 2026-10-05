import { describe, expect, it } from "vitest";
import { default_assessment, type TestBasis } from "../src/assessment.js";
import { parse_history_jsonl } from "../src/history.js";
import { run_checkers } from "../src/index.js";

/**
 * PR-10e: AUTH-02 inconclusive explanation must not label non-committed receipts
 * (outcome=unknown/rejected, possibly properly bound) as "committed, unlinked".
 * All assertions go through the real run_checkers.
 */

const NOT_COMMITTED_PREFIX = "Receipt(s) with an outcome other than committed";
const UNLINKED_PREFIX = "Committed effect not linked";
const NO_COMMITTED =
  "No outcome=committed effect.receipt observed; AUTH-02 cannot be positively supported.";
const ALL_UNLINKED = "All committed effect.receipt(s) are unlinked (no action_digest).";

function auth02(lines: string[], test_basis: TestBasis = "synthetic_fixture") {
  const assessment = default_assessment();
  assessment.test_basis = test_basis;
  const events = parse_history_jsonl(lines.join("\n"), { warn_unknown_vocab: false });
  const f = run_checkers(events, null, assessment).find((x) => x.invariant === "AUTH-02");
  expect(f, "AUTH-02").toBeTruthy();
  return f!;
}

const BIND = `{"seq":1,"kind":"ok","op":"action.bind","actor_id":"agent","attrs":{"action_type":"tool.Write","target":"/ws/a.txt","args":{"file_path":"/ws/a.txt","content":"x"},"action_digest":"d1","runtime_generation":1}}`;
const GRANT = `{"seq":2,"kind":"ok","op":"approval.grant","actor_id":"approver_client","attrs":{"approver":"approver_client","action_digest":"d1","decision":"grant","runtime_generation":1,"option_kind":"allow_once"}}`;

describe("PR-10e: AUTH-02 inconclusive explanation splits non-committed vs committed-unlinked", () => {
  it("unknown receipt linked to action.bind → non-committed sentence, no 'Committed effect not linked'", () => {
    const f = auth02([
      BIND,
      GRANT,
      `{"seq":3,"kind":"ok","op":"effect.receipt","attrs":{"effect_id":"tc1","action_digest":"d1","runtime_generation":1,"outcome":"unknown","path":"/ws/a.txt"}}`,
    ]);
    expect(f.observed_result).toBe("inconclusive");
    expect(f.witness_seqs).toEqual([3]);
    expect(f.explanation).toContain(NOT_COMMITTED_PREFIX);
    expect(f.explanation).not.toContain(UNLINKED_PREFIX);
    expect(f.explanation).toBe(
      `${NO_COMMITTED} Receipt(s) with an outcome other than committed (no effect confirmed); witness_seqs=[3].`,
    );
  });

  it("only committed receipt with binding=unlinked → original unlinked sentence unchanged", () => {
    const f = auth02([
      `{"seq":1,"kind":"ok","op":"session.attach","actor_id":"adapter","attrs":{}}`,
      `{"seq":2,"kind":"ok","op":"effect.receipt","attrs":{"effect_id":"fs:/ws/b.txt","outcome":"committed","path":"/ws/b.txt","binding":"unlinked","runtime_generation":1}}`,
    ]);
    expect(f.observed_result).toBe("inconclusive");
    expect(f.witness_seqs).toEqual([2]);
    expect(f.explanation).not.toContain(NOT_COMMITTED_PREFIX);
    expect(f.explanation).toBe(
      `${ALL_UNLINKED} Committed effect not linked to any action.bind (binding=unlinked); witness_seqs=[2].`,
    );
  });

  it("one non-committed + one committed-unlinked → both sentences in order, each with only its own seqs", () => {
    const f = auth02([
      BIND,
      GRANT,
      `{"seq":3,"kind":"ok","op":"effect.receipt","attrs":{"effect_id":"fs:/ws/b.txt","outcome":"committed","path":"/ws/b.txt","binding":"unlinked","runtime_generation":1}}`,
      `{"seq":4,"kind":"ok","op":"effect.receipt","attrs":{"effect_id":"tc1","action_digest":"d1","runtime_generation":1,"outcome":"unknown","path":"/ws/a.txt"}}`,
    ]);
    expect(f.observed_result).toBe("inconclusive");
    expect(f.witness_seqs).toEqual([3, 4]);
    expect(f.explanation).toContain(NOT_COMMITTED_PREFIX);
    expect(f.explanation).toBe(
      `${ALL_UNLINKED}` +
        ` Receipt(s) with an outcome other than committed (no effect confirmed); witness_seqs=[4].` +
        ` Committed effect not linked to any action.bind (binding=unlinked); witness_seqs=[3].`,
    );
  });
});
