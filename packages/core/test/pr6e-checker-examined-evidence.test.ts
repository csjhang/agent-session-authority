import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { default_assessment, type TestBasis } from "../src/assessment.js";
import type { AuthorityProfile } from "../src/declaration.js";
import { load_profile } from "../src/declaration.js";
import { load_history_file, parse_history_jsonl } from "../src/history.js";
import { run_checkers } from "../src/index.js";
import { validate_json } from "../src/schema.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo_root = path.resolve(here, "../../..");
const BASES: TestBasis[] = ["synthetic_fixture", "research_profile", "vendor_claim"];

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

function load_corpus(dir: string, name: string) {
  const history = load_history_file(path.join(repo_root, "corpus", dir, name), {
    warn_unknown_vocab: false,
  });
  const profile = load_profile(path.join(repo_root, "corpus", dir, "profile.json"));
  const assessment = default_assessment();
  assessment.test_basis = "synthetic_fixture";
  assessment.target = profile?.target ?? dir;
  return { findings: run_checkers(history, profile, assessment), profile };
}

function load_schema(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(repo_root, "spec", name), "utf8"));
}

describe("PR-6e: checker examined evidence", () => {
  it("Two runtimes, no restart (runtime_a gen 5, runtime_b gen 1) → AUTH-01b not violation; inconclusive (no restart observed, cross-restart increment not examined).", () => {
    const profile = load_profile(path.join(repo_root, "corpus", "auth01", "profile.json"));
    const f = inv_of(
      check(
        [
          `{"seq":1,"kind":"observe","op":"generation.observe","attrs":{"runtime_generation":5,"issuer_id":"lease_plane","runtime_id":"runtime_a"}}`,
          `{"seq":2,"kind":"observe","op":"generation.observe","attrs":{"runtime_generation":1,"issuer_id":"lease_plane","runtime_id":"runtime_b"}}`,
        ],
        profile,
      ),
      "AUTH-01b",
    );
    expect(f.result).not.toBe("violation");
    expect(f.observed_result).toBe("inconclusive");
    expect(f.explanation).toMatch(/no restart observed, cross-restart increment not examined/);
  });

  it("After restart first generation.observe has no numeric value, next same gen as before restart → AUTH-01b violation.", () => {
    const profile = load_profile(path.join(repo_root, "corpus", "auth01", "profile.json"));
    const f = inv_of(
      check(
        [
          `{"seq":1,"kind":"observe","op":"generation.observe","attrs":{"runtime_generation":5,"issuer_id":"lease_plane","runtime_id":"runtime_a"}}`,
          `{"seq":2,"kind":"fault","fault":"runtime.restart","attrs":{"runtime_id":"runtime_a"}}`,
          `{"seq":3,"kind":"observe","op":"generation.observe","attrs":{"issuer_id":"lease_plane","runtime_id":"runtime_a"}}`,
          `{"seq":4,"kind":"observe","op":"generation.observe","attrs":{"runtime_generation":5,"issuer_id":"lease_plane","runtime_id":"runtime_a"}}`,
        ],
        profile,
      ),
      "AUTH-01b",
    );
    expect(f.observed_result).toBe("violation");
    expect(f.result).toBe("violation");
  });

  it("Restart with neither runtime_id nor session_id, observes before/after span two streams → AUTH-01b inconclusive, witness = that restart seq.", () => {
    const profile = load_profile(path.join(repo_root, "corpus", "auth01", "profile.json"));
    const f = inv_of(
      check(
        [
          `{"seq":1,"kind":"observe","op":"generation.observe","attrs":{"runtime_generation":5,"issuer_id":"lease_plane","runtime_id":"runtime_a"}}`,
          `{"seq":2,"kind":"observe","op":"generation.observe","attrs":{"runtime_generation":1,"issuer_id":"lease_plane","runtime_id":"runtime_b"}}`,
          `{"seq":3,"kind":"fault","fault":"runtime.restart"}`,
          `{"seq":4,"kind":"observe","op":"generation.observe","attrs":{"runtime_generation":6,"issuer_id":"lease_plane","runtime_id":"runtime_a"}}`,
          `{"seq":5,"kind":"observe","op":"generation.observe","attrs":{"runtime_generation":2,"issuer_id":"lease_plane","runtime_id":"runtime_b"}}`,
        ],
        profile,
      ),
      "AUTH-01b",
    );
    expect(f.observed_result).toBe("inconclusive");
    expect(f.witness_seqs).toEqual([3]);
  });

  it("G1 profile, generation.observe without issuer_id → AUTH-01c inconclusive.", () => {
    const profile: AuthorityProfile = {
      profile_version: "0.2",
      generation_model: "G1",
      claimed_invariants: ["AUTH-01c"],
    };
    const f = inv_of(
      check(
        [
          `{"seq":1,"kind":"observe","op":"generation.observe","attrs":{"runtime_generation":1,"runtime_id":"runtime_a"}}`,
          `{"seq":2,"kind":"observe","op":"generation.observe","attrs":{"runtime_generation":2,"runtime_id":"runtime_a"}}`,
        ],
        profile,
      ),
      "AUTH-01c",
    );
    expect(f.observed_result).toBe("inconclusive");
    expect(f.explanation).toMatch(
      /no generation\.observe carries both issuer_id and runtime_id\/fenced_object_id; issuer separation not examined/,
    );
    expect(f.witness_seqs).toEqual([]);
  });

  it('Profile claims only ["AUTH-01"], no generation_model → AUTH-01a claim_status=declared, observed_result=underspecified.', () => {
    const profile: AuthorityProfile = {
      profile_version: "0.2",
      claimed_invariants: ["AUTH-01"],
    };
    const f = inv_of(check([`{"seq":1,"kind":"info","op":"session.start"}`], profile), "AUTH-01a");
    expect(f.claim_status).toBe("declared");
    expect(f.observed_result).toBe("underspecified");
    expect(f.explanation).toMatch(
      /AUTH-01a is claimed but the profile declares no generation_model\./,
    );
  });

  it("Profile has no scope mapping, bind without scope_id → AUTH-03a inconclusive.", () => {
    const profile: AuthorityProfile = {
      profile_version: "0.2",
      claimed_invariants: ["AUTH-03a"],
      generation_model: "G0",
    };
    const f = inv_of(
      check(
        [
          `{"seq":1,"kind":"ok","op":"action.bind","actor_id":"c1","attrs":{"action_type":"file.write","target":"repo/a.ts"}}`,
        ],
        profile,
      ),
      "AUTH-03a",
    );
    expect(f.observed_result).toBe("inconclusive");
    expect(f.explanation).toMatch(
      /no bind with a self-declared scope_id matched a published scope mapping; scope determinism not examined/,
    );
  });

  it("c1 acquires scope s epoch 1, c2 acquires s epoch 2, c1 commits on s → AUTH-03c violation.", () => {
    const profile = load_profile(path.join(repo_root, "corpus", "auth03", "profile.json"));
    const f = inv_of(
      check(
        [
          `{"seq":1,"kind":"ok","op":"lease.acquire","actor_id":"c1","attrs":{"scope_id":"s","holder":"c1","fence_epoch":1,"accepted":true}}`,
          `{"seq":2,"kind":"ok","op":"lease.acquire","actor_id":"c2","attrs":{"scope_id":"s","holder":"c2","fence_epoch":2,"accepted":true}}`,
          `{"seq":3,"kind":"ok","op":"effect.receipt","attrs":{"effect_id":"e1","outcome":"committed","scope_id":"s","controller":"c1"}}`,
        ],
        profile,
      ),
      "AUTH-03c",
    );
    expect(f.observed_result).toBe("violation");
  });

  it("c1 acquires s epoch 2, c2 accepted at lower epoch 1, c1 commits on s → AUTH-03c still supported (lower epoch does not replace).", () => {
    const profile = load_profile(path.join(repo_root, "corpus", "auth03", "profile.json"));
    const f = inv_of(
      check(
        [
          `{"seq":1,"kind":"ok","op":"lease.acquire","actor_id":"c1","attrs":{"scope_id":"s","holder":"c1","fence_epoch":2,"accepted":true}}`,
          `{"seq":2,"kind":"ok","op":"lease.acquire","actor_id":"c2","attrs":{"scope_id":"s","holder":"c2","fence_epoch":1,"accepted":true}}`,
          `{"seq":3,"kind":"ok","op":"effect.receipt","attrs":{"effect_id":"e1","outcome":"committed","scope_id":"s","controller":"c1"}}`,
        ],
        profile,
      ),
      "AUTH-03c",
    );
    expect(f.observed_result).toBe("supported");
  });

  it("Assert expected findings for all 6 corpus files in section 2 one by one.", () => {
    {
      const { findings } = load_corpus("auth03", "pass-contended.jsonl");
      expect(findings.filter((x) => x.result === "violation")).toEqual([]);
      const a = inv_of(findings, "AUTH-03a");
      expect(a.observed_result).toBe("supported");
      expect(a.witness_seqs).toEqual([5]);
      const b = inv_of(findings, "AUTH-03b");
      expect(b.observed_result).toBe("supported");
      expect(b.witness_seqs).toEqual([1, 2, 4]);
      const c = inv_of(findings, "AUTH-03c");
      expect(c.observed_result).toBe("supported");
      expect(c.witness_seqs).toEqual([4, 7]);
      const d = inv_of(findings, "AUTH-04");
      expect(d.observed_result).toBe("supported");
      expect(d.witness_seqs).toEqual([4, 7]);
    }
    {
      const { findings } = load_corpus("auth04", "inconclusive-no-fence-change.jsonl");
      expect(inv_of(findings, "AUTH-03b").observed_result).toBe("inconclusive");
      expect(inv_of(findings, "AUTH-03b").explanation).toMatch(/no lease contention examined/);
      expect(inv_of(findings, "AUTH-03c").observed_result).toBe("supported");
      expect(inv_of(findings, "AUTH-04").observed_result).toBe("inconclusive");
      expect(inv_of(findings, "AUTH-04").explanation).toMatch(/no fence change examined/);
    }
    {
      const { findings } = load_corpus("auth04", "inconclusive-unattributed-scope.jsonl");
      const f = inv_of(findings, "AUTH-04");
      expect(f.observed_result).toBe("inconclusive");
      expect(f.witness_seqs).toEqual([3]);
    }
    {
      const { findings } = load_corpus("auth01", "pass-two-runtimes.jsonl");
      expect(findings.filter((x) => x.result === "violation")).toEqual([]);
      const b = inv_of(findings, "AUTH-01b");
      expect(b.observed_result).toBe("supported");
      expect(b.witness_seqs).toEqual([1, 2, 3, 4, 5, 6]);
      const c = inv_of(findings, "AUTH-01c");
      expect(c.observed_result).toBe("supported");
      expect(c.witness_seqs).toEqual([1, 2, 4, 6]);
    }
    {
      const { findings } = load_corpus("auth07", "violate-late-commit-after-restart.jsonl");
      const f = inv_of(findings, "AUTH-07");
      expect(f.observed_result).toBe("violation");
      expect(f.witness_seqs).toEqual([3, 4]);
      expect(f.explanation).toBe(
        "Terminal race (restart vs complete) for tc1 not covered by published terminal_rules.",
      );
    }
    {
      const { findings } = load_corpus("auth07", "violate-reconcile-required-missing.jsonl");
      const f = inv_of(findings, "AUTH-07");
      expect(f.observed_result).toBe("violation");
      expect(f.witness_seqs).toEqual([1, 2]);
      expect(f.explanation).toMatch(
        /Terminal race \(timeout vs complete\) for e2 requires reconciliation \(reconcile_required\) but none was observed\./,
      );
    }
  });

  it("bind with only tool_call_id → receipt committed → then restart → AUTH-07 inconclusive not supported.", () => {
    const profile = load_profile(path.join(repo_root, "corpus", "auth07", "profile.json"));
    const f = inv_of(
      check(
        [
          `{"seq":1,"kind":"ok","op":"action.bind","session_id":"s1","attrs":{"action_type":"tool.Write","target":"/ws/a.txt","tool_call_id":"tc1"}}`,
          `{"seq":2,"kind":"ok","op":"effect.receipt","session_id":"s1","attrs":{"tool_call_id":"tc1","outcome":"committed"}}`,
          `{"seq":3,"kind":"fault","fault":"runtime.restart","session_id":"s1"}`,
        ],
        profile,
      ),
      "AUTH-07",
    );
    expect(f.observed_result).toBe("inconclusive");
    expect(f.result).not.toBe("supported");
  });

  it("cancel vs complete race, rule value bogus_wins, profile has another known rule, no reconciliation (pass profile object directly to run_checkers, not load_profile) → AUTH-07 violation containing `unknown rule value bogus_wins`.", () => {
    const profile: AuthorityProfile = {
      profile_version: "0.2",
      claimed_invariants: ["AUTH-07"],
      terminal_rules: {
        cancel_vs_complete: "bogus_wins",
        timeout_vs_complete: "timeout_wins",
      },
    };
    const assessment = default_assessment();
    assessment.test_basis = "synthetic_fixture";
    const findings = run_checkers(
      parse([
        `{"seq":1,"kind":"ok","op":"task.cancel","attrs":{"effect_id":"e1"}}`,
        `{"seq":2,"kind":"ok","op":"effect.receipt","attrs":{"effect_id":"e1","outcome":"committed"}}`,
      ]),
      profile,
      assessment,
    );
    const f = inv_of(findings, "AUTH-07");
    expect(f.observed_result).toBe("violation");
    expect(f.explanation).toMatch(/unknown rule value bogus_wins/);
  });

  it("schema: terminal_rules value bogus_wins → validate_json errors; reconcile_required → no error.", () => {
    const profile_schema = load_schema("authority-profile.schema.json");
    const bad = validate_json(profile_schema, {
      terminal_rules: { cancel_vs_complete: "bogus_wins" },
    });
    expect(bad.length).toBeGreaterThan(0);
    const good = validate_json(profile_schema, {
      terminal_rules: { timeout_vs_complete: "reconcile_required" },
    });
    expect(good).toEqual([]);
  });

  it("The 6 new corpora: under synthetic_fixture, research_profile, vendor_claim — observed_result and witness_seqs identical.", () => {
    const files = [
      "corpus/auth03/pass-contended.jsonl",
      "corpus/auth04/inconclusive-no-fence-change.jsonl",
      "corpus/auth04/inconclusive-unattributed-scope.jsonl",
      "corpus/auth01/pass-two-runtimes.jsonl",
      "corpus/auth07/violate-late-commit-after-restart.jsonl",
      "corpus/auth07/violate-reconcile-required-missing.jsonl",
    ];
    const diffs: string[] = [];
    for (const file of files) {
      const historyPath = path.join(repo_root, file);
      const dir = path.dirname(historyPath);
      const profile = load_profile(path.join(dir, "profile.json"));
      const events = load_history_file(historyPath, { warn_unknown_vocab: false });
      const by_basis = new Map<TestBasis, ReturnType<typeof run_checkers>>();
      for (const basis of BASES) {
        const assessment = default_assessment();
        assessment.test_basis = basis;
        by_basis.set(basis, run_checkers(events, profile, assessment));
      }
      const synthetic = by_basis.get("synthetic_fixture")!;
      for (const basis of BASES) {
        if (basis === "synthetic_fixture") continue;
        const other = by_basis.get(basis)!;
        const syn_by = new Map(synthetic.map((f) => [f.invariant, f]));
        const oth_by = new Map(other.map((f) => [f.invariant, f]));
        for (const inv of new Set([...syn_by.keys(), ...oth_by.keys()])) {
          const a = syn_by.get(inv)!;
          const b = oth_by.get(inv)!;
          if (a.observed_result !== b.observed_result) {
            diffs.push(`${file} ${inv} observed_result ${a.observed_result}!=${b.observed_result} (${basis})`);
          }
          if (JSON.stringify(a.witness_seqs) !== JSON.stringify(b.witness_seqs)) {
            diffs.push(`${file} ${inv} witness_seqs differ (${basis})`);
          }
        }
      }
    }
    expect(diffs).toEqual([]);
  });
});
