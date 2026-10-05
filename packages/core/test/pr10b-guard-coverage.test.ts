import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { default_assessment, type TestBasis } from "../src/assessment.js";
import type { AuthorityProfile } from "../src/declaration.js";
import { load_profile } from "../src/declaration.js";
import { load_history_file, parse_history_jsonl } from "../src/history.js";
import { run_checkers } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo_root = path.resolve(here, "../../..");
const LIVE_RUNS = path.join(repo_root, "targets/claude-agent-acp/results/live-runs");
const PREREQ_ABSENT = "Required prerequisite observations are absent.";
const NOT_ENOUGH = "Not enough observations for a positive conclusion.";
const SAME_GEN_EXPLANATION =
  "Committed effect.receipt(s) matched same-generation approval.grant; no action-bound approval reuse after binding-field change.";
const GUARD_INVARIANTS = ["AUTH-03a", "AUTH-03b", "AUTH-03c", "AUTH-04", "AUTH-05"] as const;

function parse(lines: string[]) {
  return parse_history_jsonl(lines.join("\n"), { warn_unknown_vocab: false });
}

function check(
  lines: string[],
  profile: AuthorityProfile | null,
  test_basis: TestBasis = "synthetic_fixture",
) {
  const assessment = default_assessment();
  assessment.test_basis = test_basis;
  return run_checkers(parse(lines), profile, assessment);
}

function inv_of(findings: ReturnType<typeof run_checkers>, inv: string) {
  const f = findings.find((x) => x.invariant === inv);
  expect(f, inv).toBeTruthy();
  return f!;
}

function list_live_histories(): string[] {
  const out: string[] = [];
  for (const scenario of fs.readdirSync(LIVE_RUNS).sort()) {
    const scenario_dir = path.join(LIVE_RUNS, scenario);
    if (!fs.statSync(scenario_dir).isDirectory()) continue;
    for (const run_id of fs.readdirSync(scenario_dir).sort()) {
      const hist = path.join(scenario_dir, run_id, "history.jsonl");
      if (fs.existsSync(hist)) out.push(hist);
    }
  }
  return out;
}

describe("PR-10b A: observation_guard prerequisites (AUTH-03a..05)", () => {
  it("all 13 committed live runs: AUTH-03a/03b/03c/04/05 inconclusive with exact prerequisite-absent explanation", () => {
    const histories = list_live_histories();
    expect(histories.length).toBeGreaterThanOrEqual(13);
    const assessment = default_assessment();
    // Match generate-capability-vectors: research_profile basis, no target profile loaded.
    assessment.test_basis = "research_profile";
    for (const hist of histories) {
      const events = load_history_file(hist, { warn_unknown_vocab: false });
      const findings = run_checkers(events, null, assessment);
      const rel = path.relative(repo_root, hist).split(path.sep).join("/");
      for (const inv of GUARD_INVARIANTS) {
        const f = inv_of(findings, inv);
        expect(f.observed_result, `${rel} ${inv}`).toBe("inconclusive");
        expect(f.explanation, `${rel} ${inv}`).toBe(PREREQ_ABSENT);
      }
    }
  });

  it("minimal ACP-shaped synthetic (grant+receipt, no lease/scope/fence): same prerequisite-absent explanations", () => {
    const findings = check(
      [
        `{"seq":1,"kind":"ok","op":"action.bind","actor_id":"agent","attrs":{"action_type":"tool.Write","target":"/ws/a.txt","action_digest":"d1","runtime_generation":1}}`,
        `{"seq":2,"kind":"ok","op":"approval.grant","actor_id":"approver_client","attrs":{"approver":"approver_client","action_digest":"d1","decision":"grant","runtime_generation":1,"option_kind":"allow_once"}}`,
        `{"seq":3,"kind":"ok","op":"effect.receipt","attrs":{"effect_id":"tc1","action_digest":"d1","runtime_generation":1,"outcome":"committed","path":"/ws/a.txt"}}`,
      ],
      null,
      "research_profile",
    );
    for (const inv of GUARD_INVARIANTS) {
      const f = inv_of(findings, inv);
      expect(f.observed_result, inv).toBe("inconclusive");
      expect(f.explanation, inv).toBe(PREREQ_ABSENT);
    }
  });
});

describe("PR-10b B: AUTH-05 examined evidence_guard", () => {
  const profile = load_profile(path.join(repo_root, "corpus", "auth05", "profile.json"));

  it("prerequisites met but no accepted lease with holder → AUTH-05 inconclusive (not enough observations), no violation", () => {
    // alice grants; bob (not the approver) dispatches; receipt present. No lease.acquire.
    const f = inv_of(
      check(
        [
          `{"seq":1,"kind":"ok","op":"approval.grant","actor_id":"alice","attrs":{"approver":"alice","action_digest":"d1","decision":"grant"}}`,
          `{"seq":2,"kind":"ok","op":"effect.dispatch","actor_id":"bob","attrs":{"effect_id":"e1","action_digest":"d1","status":"dispatched"}}`,
          `{"seq":3,"kind":"ok","op":"effect.receipt","attrs":{"effect_id":"e1","outcome":"committed","action_digest":"d1"}}`,
        ],
        profile,
      ),
      "AUTH-05",
    );
    expect(f.observed_result).toBe("inconclusive");
    expect(f.result).toBe("inconclusive");
    expect(f.explanation).toBe(NOT_ENOUGH);
    expect(f.witness_seqs).toEqual([]);
  });

  it("grant with approver + accepted lease with holder + dispatch by lease holder → AUTH-05 supported with witnesses", () => {
    const f = inv_of(
      check(
        [
          `{"seq":1,"kind":"ok","op":"approval.grant","actor_id":"alice","attrs":{"approver":"alice","action_digest":"d1","decision":"grant"}}`,
          `{"seq":2,"kind":"ok","op":"lease.acquire","actor_id":"bob","attrs":{"scope_id":"workspace","holder":"bob","fence_epoch":1,"accepted":true}}`,
          `{"seq":3,"kind":"ok","op":"effect.dispatch","actor_id":"bob","attrs":{"effect_id":"e1","action_digest":"d1","status":"dispatched"}}`,
        ],
        profile,
      ),
      "AUTH-05",
    );
    expect(f.observed_result).toBe("supported");
    expect(f.result).toBe("supported");
    expect(f.witness_seqs.length).toBeGreaterThan(0);
    expect(f.explanation).toMatch(/No conflation of approval and control observed/);
  });
});

describe("PR-10b C: AUTH-02 cross_generation_grant", () => {
  const profile = load_profile(path.join(repo_root, "corpus", "auth02", "profile.json"));

  it("allow_always: gen1 grant, restart, gen2 committed receipt same digest → violation with cross_generation_grant", () => {
    const f = inv_of(
      check(
        [
          `{"seq":1,"kind":"ok","op":"action.bind","actor_id":"agent","attrs":{"action_type":"file.write","target":"repo/a.ts","args":{"content":"x"},"policy_version":"p1","runtime_generation":1,"nonce":"n1","action_digest":"digest_x"}}`,
          `{"seq":2,"kind":"ok","op":"approval.grant","actor_id":"approver","attrs":{"approver":"approver","action_digest":"digest_x","decision":"grant","option_kind":"allow_always","runtime_generation":1}}`,
          `{"seq":3,"kind":"fault","fault":"runtime.restart","note":"restart between grant and use"}`,
          `{"seq":4,"kind":"ok","op":"effect.receipt","attrs":{"effect_id":"eff_g2","action_digest":"digest_x","runtime_generation":2,"outcome":"committed"}}`,
        ],
        profile,
      ),
      "AUTH-02",
    );
    expect(f.observed_result).toBe("violation");
    expect(f.explanation).toMatch(/cross_generation_grant/);
  });

  it("allow_once: gen1 grant unused, restart, gen2 consumes it → violation with cross_generation_grant", () => {
    const f = inv_of(
      check(
        [
          `{"seq":1,"kind":"ok","op":"action.bind","actor_id":"agent","attrs":{"action_type":"file.write","target":"repo/a.ts","args":{"content":"x"},"policy_version":"p1","runtime_generation":1,"nonce":"n1","action_digest":"digest_once"}}`,
          `{"seq":2,"kind":"ok","op":"approval.grant","actor_id":"approver","attrs":{"approver":"approver","action_digest":"digest_once","decision":"grant","option_kind":"allow_once","runtime_generation":1}}`,
          `{"seq":3,"kind":"fault","fault":"runtime.restart","note":"restart before once-grant is consumed"}`,
          `{"seq":4,"kind":"ok","op":"effect.receipt","attrs":{"effect_id":"eff_late","action_digest":"digest_once","runtime_generation":2,"outcome":"committed"}}`,
        ],
        profile,
      ),
      "AUTH-02",
    );
    expect(f.observed_result).toBe("violation");
    expect(f.explanation).toMatch(/cross_generation_grant/);
  });
});

describe("PR-10b D: AUTH-02 supported explanation (generation compared vs not)", () => {
  it("every counted receipt compared generation → original same-generation explanation", () => {
    const history = load_history_file(path.join(repo_root, "corpus", "auth02", "pass.jsonl"), {
      warn_unknown_vocab: false,
    });
    const profile = load_profile(path.join(repo_root, "corpus", "auth02", "profile.json"));
    const f = inv_of(run_checkers(history, profile, default_assessment()), "AUTH-02");
    expect(f.observed_result).toBe("supported");
    expect(f.explanation).toBe(SAME_GEN_EXPLANATION);
  });

  it("at least one counted receipt missing generation compare → no same-generation wording + N of M note", () => {
    // corpus/auth01/violate.jsonl: grant has no runtime_generation; receipt has gen 1.
    const history = load_history_file(path.join(repo_root, "corpus", "auth01", "violate.jsonl"), {
      warn_unknown_vocab: false,
    });
    const profile = load_profile(path.join(repo_root, "corpus", "auth01", "profile.json"));
    const f = inv_of(run_checkers(history, profile, default_assessment()), "AUTH-02");
    expect(f.observed_result).toBe("supported");
    expect(f.witness_seqs).toEqual([2, 5]);
    expect(f.explanation).toBe(
      "Committed effect.receipt(s) matched approval.grant; no action-bound approval reuse after binding-field change." +
        " runtime_generation not compared for 1 of 1 counted receipt(s) (missing on the grant or the receipt).",
    );
    expect(f.explanation).not.toMatch(/same-generation/);
  });

  it("unlinked note still appended after not-compared generation note", () => {
    const f = inv_of(
      check(
        [
          `{"seq":1,"kind":"ok","op":"action.bind","actor_id":"agent","attrs":{"action_type":"file.write","target":"repo/a.ts","args":{"content":"x"},"policy_version":"p1","action_digest":"d1"}}`,
          `{"seq":2,"kind":"ok","op":"approval.grant","actor_id":"approver","attrs":{"approver":"approver","action_digest":"d1","decision":"grant"}}`,
          `{"seq":3,"kind":"ok","op":"effect.receipt","attrs":{"effect_id":"eff_ok","action_digest":"d1","runtime_generation":1,"outcome":"committed"}}`,
          `{"seq":4,"kind":"ok","op":"effect.receipt","attrs":{"effect_id":"eff_unlink","outcome":"committed","binding":"unlinked"}}`,
        ],
        load_profile(path.join(repo_root, "corpus", "auth02", "profile.json")),
      ),
      "AUTH-02",
    );
    expect(f.observed_result).toBe("supported");
    expect(f.explanation).toMatch(
      /runtime_generation not compared for 1 of 1 counted receipt\(s\) \(missing on the grant or the receipt\)\./,
    );
    expect(f.explanation).toMatch(/Also 1 unlinked committed receipt\(s\)/);
    expect(f.explanation).toMatch(/witness_seqs=\[4\]/);
  });
});
