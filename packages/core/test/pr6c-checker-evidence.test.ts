import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { default_assessment, type TestBasis } from "../src/assessment.js";
import type { AuthorityProfile } from "../src/declaration.js";
import { load_profile } from "../src/declaration.js";
import { KNOWN_OPS, load_history_file, parse_history_jsonl } from "../src/history.js";
import { run_checkers } from "../src/index.js";

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

function list_corpus_and_target_histories(): Array<{
  file: string;
  historyPath: string;
  profilePath: string | null;
}> {
  const out: Array<{ file: string; historyPath: string; profilePath: string | null }> = [];
  const corpusRoot = path.join(repo_root, "corpus");
  for (const dir of fs.readdirSync(corpusRoot).sort()) {
    const dirPath = path.join(corpusRoot, dir);
    if (!fs.statSync(dirPath).isDirectory()) continue;
    const profilePath = path.join(dirPath, "profile.json");
    const hasProfile = fs.existsSync(profilePath);
    for (const name of fs.readdirSync(dirPath).sort()) {
      if (!name.endsWith(".jsonl")) continue;
      out.push({
        file: path.relative(repo_root, path.join(dirPath, name)).split(path.sep).join("/"),
        historyPath: path.join(dirPath, name),
        profilePath: hasProfile ? profilePath : null,
      });
    }
  }
  const targetsRoot = path.join(repo_root, "targets");
  for (const t of fs.readdirSync(targetsRoot).sort()) {
    const hist = path.join(targetsRoot, t, "results", "history-fixture.jsonl");
    if (!fs.existsSync(hist)) continue;
    const candidates = [
      path.join(targetsRoot, t, "profile.json"),
      path.join(targetsRoot, t, "results", "profile.json"),
    ];
    out.push({
      file: path.relative(repo_root, hist).split(path.sep).join("/"),
      historyPath: hist,
      profilePath: candidates.find((p) => fs.existsSync(p)) ?? null,
    });
  }
  return out;
}

describe("PR-6c: test_basis must not affect observed_result / witness_seqs", () => {
  it("corpus (with and without profile) + four target fixtures: observed_result and witness_seqs identical across bases", () => {
    const diffs: string[] = [];
    for (const h of list_corpus_and_target_histories()) {
      const events = load_history_file(h.historyPath, { warn_unknown_vocab: false });
      const loaded = h.profilePath ? load_profile(h.profilePath) : null;
      const profileModes: Array<{ label: string; profile: AuthorityProfile | null }> = h.profilePath
        ? [
            { label: "with_profile", profile: loaded },
            { label: "without_profile", profile: null },
          ]
        : [{ label: "without_profile", profile: null }];
      for (const mode of profileModes) {
        const by_basis = new Map<TestBasis, ReturnType<typeof run_checkers>>();
        for (const basis of BASES) {
          const assessment = default_assessment();
          assessment.test_basis = basis;
          by_basis.set(basis, run_checkers(events, mode.profile, assessment));
        }
        const synthetic = by_basis.get("synthetic_fixture")!;
        for (const basis of BASES) {
          if (basis === "synthetic_fixture") continue;
          const other = by_basis.get(basis)!;
          const syn_by_inv = new Map(synthetic.map((f) => [f.invariant, f]));
          const oth_by_inv = new Map(other.map((f) => [f.invariant, f]));
          const keys = new Set([...syn_by_inv.keys(), ...oth_by_inv.keys()]);
          for (const inv of keys) {
            const a = syn_by_inv.get(inv);
            const b = oth_by_inv.get(inv);
            if (!a || !b) {
              diffs.push(`${h.file} ${mode.label} ${inv}: missing under ${!a ? "synthetic_fixture" : basis}`);
              continue;
            }
            if (a.observed_result !== b.observed_result) {
              diffs.push(
                `${h.file} ${mode.label} ${inv}: observed_result synthetic=${a.observed_result} ${basis}=${b.observed_result}`,
              );
            }
            if (JSON.stringify(a.witness_seqs) !== JSON.stringify(b.witness_seqs)) {
              diffs.push(
                `${h.file} ${mode.label} ${inv}: witness_seqs synthetic=${JSON.stringify(a.witness_seqs)} ${basis}=${JSON.stringify(b.witness_seqs)}`,
              );
            }
          }
        }
      }
    }
    expect(diffs, `${diffs.length} diffs:\n${diffs.join("\n")}`).toEqual([]);
  });
});

describe("PR-6c: AUTH-01b no evidence → not supported", () => {
  const observe1 = '{"seq":1,"kind":"observe","op":"generation.observe","attrs":{"runtime_generation":1}}';
  const restart2 = '{"seq":2,"kind":"fault","fault":"runtime.restart"}';
  const observe3g2 = '{"seq":3,"kind":"observe","op":"generation.observe","attrs":{"runtime_generation":2}}';
  const observe3g1 = '{"seq":3,"kind":"observe","op":"generation.observe","attrs":{"runtime_generation":1}}';
  const restart4 = '{"seq":4,"kind":"fault","fault":"runtime.restart"}';
  const claimed: AuthorityProfile = {
    profile_version: "0.2",
    target: "t",
    generation_model: "G1",
    claimed_invariants: ["AUTH-01b"],
  };

  it("observe gen1 → restart → observe gen2: supported, witness [1,2,3]", () => {
    const f = inv_of(check([observe1, restart2, observe3g2], claimed), "AUTH-01b");
    expect(f.observed_result).toBe("supported");
    expect(f.result).toBe("supported");
    expect(f.witness_seqs).toEqual([1, 2, 3]);
  });

  it("observe gen1 → restart, no later observe: inconclusive, witness [2]", () => {
    const f = inv_of(check([observe1, restart2], claimed), "AUTH-01b");
    expect(f.observed_result).toBe("inconclusive");
    expect(f.result).toBe("inconclusive");
    expect(f.witness_seqs).toEqual([2]);
  });

  it("only observe gen1: inconclusive", () => {
    const f = inv_of(check([observe1], claimed), "AUTH-01b");
    expect(f.observed_result).toBe("inconclusive");
    expect(f.result).toBe("inconclusive");
    expect(f.explanation).toMatch(/no restart observed/i);
    expect(f.explanation).toMatch(/cross-restart increment not examined/i);
  });

  it("observe1 → restart → observe2 → restart: inconclusive, witness [4]", () => {
    const f = inv_of(check([observe1, restart2, observe3g2, restart4], claimed), "AUTH-01b");
    expect(f.observed_result).toBe("inconclusive");
    expect(f.result).toBe("inconclusive");
    expect(f.witness_seqs).toEqual([4]);
  });

  it("observe1 → restart → observe1: violation", () => {
    const f = inv_of(check([observe1, restart2, observe3g1], claimed), "AUTH-01b");
    expect(f.observed_result).toBe("violation");
    expect(f.result).toBe("violation");
  });

  it("research_profile, no profile, first history: observed_result supported, result not_declared, witness non-empty", () => {
    const f = inv_of(check([observe1, restart2, observe3g2], null, "research_profile"), "AUTH-01b");
    expect(f.observed_result).toBe("supported");
    expect(f.result).toBe("not_declared");
    expect(f.witness_seqs.length).toBeGreaterThan(0);
  });
});

describe("PR-6c: AUTH-01c all branches reachable", () => {
  const attach = '{"seq":1,"kind":"ok","op":"session.attach"}';
  const observe_ok =
    '{"seq":1,"kind":"observe","op":"generation.observe","attrs":{"runtime_generation":1,"issuer_id":"issuer","runtime_id":"runtime"}}';

  it("1. empty history → not_tested", () => {
    const f = inv_of(run_checkers([], { profile_version: "0.2", target: "t", generation_model: "G1" }, default_assessment()), "AUTH-01c");
    expect(f.observed_result).toBe("not_tested");
    expect(f.result).toBe("not_tested");
  });

  it("2. generation_model G0 → supported, witness=[], profile-based explanation", () => {
    const f = inv_of(
      check([attach], { profile_version: "0.2", target: "t", generation_model: "G0", claimed_invariants: ["AUTH-01c"] }),
      "AUTH-01c",
    );
    expect(f.observed_result).toBe("supported");
    expect(f.result).toBe("supported");
    expect(f.witness_seqs).toEqual([]);
    expect(f.explanation).toMatch(/based on profile/i);
  });

  it("3. no generation_model (incl. no profile) → observed_result not_declared", () => {
    const f = inv_of(check([attach], null), "AUTH-01c");
    expect(f.observed_result).toBe("not_declared");
    expect(f.result).toBe("not_declared");
    expect(f.explanation).toBe("No profile/generation_model to evaluate issuer separation.");
    expect(f.claim_status).toBe("not_declared");
  });

  it("4. other generation_model → underspecified", () => {
    const f = inv_of(
      check([attach], { profile_version: "0.2", target: "t", generation_model: "G9" } as AuthorityProfile),
      "AUTH-01c",
    );
    expect(f.observed_result).toBe("underspecified");
    expect(f.result).toBe("underspecified");
  });

  it("5. G1/G2 but no generation.observe → inconclusive", () => {
    const f = inv_of(
      check([attach], { profile_version: "0.2", target: "t", generation_model: "G1", claimed_invariants: ["AUTH-01c"] }),
      "AUTH-01c",
    );
    expect(f.observed_result).toBe("inconclusive");
    expect(f.result).toBe("inconclusive");
  });

  it("6. G1 with observe issuer!=runtime → supported", () => {
    const f = inv_of(
      check([observe_ok], { profile_version: "0.2", target: "t", generation_model: "G1", claimed_invariants: ["AUTH-01c"] }),
      "AUTH-01c",
    );
    expect(f.observed_result).toBe("supported");
    expect(f.result).toBe("supported");
    expect(f.witness_seqs).toEqual([1]);
  });
});

describe("PR-6c: deduplicate violation explanation sentences", () => {
  it("G1 two generation.observe both issuer==runtime → explanation once, witness [1,3]", () => {
    const f = inv_of(
      check(
        [
          '{"seq":1,"kind":"observe","op":"generation.observe","attrs":{"runtime_generation":1,"issuer_id":"runtime_a","runtime_id":"runtime_a"}}',
          '{"seq":2,"kind":"ok","op":"session.attach"}',
          '{"seq":3,"kind":"observe","op":"generation.observe","attrs":{"runtime_generation":2,"issuer_id":"runtime_a","runtime_id":"runtime_a"}}',
        ],
        { profile_version: "0.2", target: "t", generation_model: "G1", claimed_invariants: ["AUTH-01c"] },
      ),
      "AUTH-01c",
    );
    expect(f.observed_result).toBe("violation");
    expect(f.witness_seqs).toEqual([1, 3]);
    const sentence = "Issuer runtime_a equals fenced runtime object.";
    expect(f.explanation).toContain(sentence);
    const occurrences = f.explanation.split(sentence).length - 1;
    expect(occurrences).toBe(1);
  });
});

describe("PR-6c: AUTH-07 terminal contention", () => {
  const no_rules: AuthorityProfile = {
    profile_version: "0.2",
    target: "t",
    claimed_invariants: ["AUTH-07"],
  };
  const cancel_wins: AuthorityProfile = {
    profile_version: "0.2",
    target: "t",
    claimed_invariants: ["AUTH-07"],
    terminal_rules: { cancel_vs_complete: "cancel_wins" },
  };

  it("task.cancel t1 → task.complete t1, no rules: violation [1,2]", () => {
    const f = inv_of(
      check(
        [
          '{"seq":1,"kind":"ok","op":"task.cancel","session_id":"s1","attrs":{"task_id":"t1"}}',
          '{"seq":2,"kind":"ok","op":"task.complete","session_id":"s1","attrs":{"task_id":"t1"}}',
        ],
        no_rules,
      ),
      "AUTH-07",
    );
    expect(f.observed_result).toBe("violation");
    expect(f.result).toBe("violation");
    expect(f.witness_seqs).toEqual([1, 2]);
  });

  it("same + unrelated restart other session: identical result", () => {
    const base = check(
      [
        '{"seq":1,"kind":"ok","op":"task.cancel","session_id":"s1","attrs":{"task_id":"t1"}}',
        '{"seq":2,"kind":"ok","op":"task.complete","session_id":"s1","attrs":{"task_id":"t1"}}',
      ],
      no_rules,
    );
    const extra = check(
      [
        '{"seq":1,"kind":"ok","op":"task.cancel","session_id":"s1","attrs":{"task_id":"t1"}}',
        '{"seq":2,"kind":"ok","op":"task.complete","session_id":"s1","attrs":{"task_id":"t1"}}',
        '{"seq":3,"kind":"fault","fault":"runtime.restart","session_id":"s-other"}',
      ],
      no_rules,
    );
    const a = inv_of(base, "AUTH-07");
    const b = inv_of(extra, "AUTH-07");
    expect(b.observed_result).toBe(a.observed_result);
    expect(b.result).toBe(a.result);
    expect(b.witness_seqs).toEqual(a.witness_seqs);
    expect(a.observed_result).toBe("violation");
    expect(a.witness_seqs).toEqual([1, 2]);
  });

  it("dispatch e1 → effect.cancel e1 → receipt committed e1, no rules: violation [2,3]", () => {
    const f = inv_of(
      check(
        [
          '{"seq":1,"kind":"ok","op":"effect.dispatch","session_id":"s1","attrs":{"effect_id":"e1"}}',
          '{"seq":2,"kind":"ok","op":"effect.cancel","session_id":"s1","attrs":{"effect_id":"e1"}}',
          '{"seq":3,"kind":"ok","op":"effect.receipt","session_id":"s1","attrs":{"effect_id":"e1","outcome":"committed"}}',
        ],
        no_rules,
      ),
      "AUTH-07",
    );
    expect(f.observed_result).toBe("violation");
    expect(f.result).toBe("violation");
    expect(f.witness_seqs).toEqual([2, 3]);
  });

  it("previous + cancel_wins + effect.reconcile cancelled: supported [2,3]", () => {
    const f = inv_of(
      check(
        [
          '{"seq":1,"kind":"ok","op":"effect.dispatch","session_id":"s1","attrs":{"effect_id":"e1"}}',
          '{"seq":2,"kind":"ok","op":"effect.cancel","session_id":"s1","attrs":{"effect_id":"e1"}}',
          '{"seq":3,"kind":"ok","op":"effect.receipt","session_id":"s1","attrs":{"effect_id":"e1","outcome":"committed"}}',
          '{"seq":4,"kind":"ok","op":"effect.reconcile","session_id":"s1","attrs":{"effect_id":"e1","resolved_terminal":"cancelled"}}',
        ],
        cancel_wins,
      ),
      "AUTH-07",
    );
    expect(f.observed_result).toBe("supported");
    expect(f.result).toBe("supported");
    expect(f.witness_seqs).toEqual([2, 3]);
  });

  it("only session.attach + restart: inconclusive", () => {
    const f = inv_of(
      check(
        [
          '{"seq":1,"kind":"ok","op":"session.attach","session_id":"s1"}',
          '{"seq":2,"kind":"fault","fault":"runtime.restart","session_id":"s1"}',
        ],
        no_rules,
      ),
      "AUTH-07",
    );
    expect(f.observed_result).toBe("inconclusive");
    expect(f.result).toBe("inconclusive");
  });

  it("dispatch e1 (open) → same-session restart: supported [2]", () => {
    const f = inv_of(
      check(
        [
          '{"seq":1,"kind":"ok","op":"effect.dispatch","session_id":"s1","attrs":{"effect_id":"e1"}}',
          '{"seq":2,"kind":"fault","fault":"runtime.restart","session_id":"s1"}',
        ],
        no_rules,
      ),
      "AUTH-07",
    );
    expect(f.observed_result).toBe("supported");
    expect(f.result).toBe("supported");
    expect(f.witness_seqs).toEqual([2]);
  });

  it("dispatch e1 → same-session restart → receipt committed, no rules: violation [2,3]", () => {
    const f = inv_of(
      check(
        [
          '{"seq":1,"kind":"ok","op":"effect.dispatch","session_id":"s1","attrs":{"effect_id":"e1"}}',
          '{"seq":2,"kind":"fault","fault":"runtime.restart","session_id":"s1"}',
          '{"seq":3,"kind":"ok","op":"effect.receipt","session_id":"s1","attrs":{"effect_id":"e1","outcome":"committed"}}',
        ],
        no_rules,
      ),
      "AUTH-07",
    );
    expect(f.observed_result).toBe("violation");
    expect(f.result).toBe("violation");
    expect(f.witness_seqs).toEqual([2, 3]);
  });

  it("dispatch e1 → receipt committed only: inconclusive", () => {
    const f = inv_of(
      check(
        [
          '{"seq":1,"kind":"ok","op":"effect.dispatch","session_id":"s1","attrs":{"effect_id":"e1"}}',
          '{"seq":2,"kind":"ok","op":"effect.receipt","session_id":"s1","attrs":{"effect_id":"e1","outcome":"committed"}}',
        ],
        no_rules,
      ),
      "AUTH-07",
    );
    expect(f.observed_result).toBe("inconclusive");
    expect(f.result).toBe("inconclusive");
    expect(f.explanation).toMatch(/no terminal contention examined/i);
  });
});

describe("PR-6c: lease.observe known + four targets parse with zero unknown vocab warnings", () => {
  it("KNOWN_OPS includes lease.observe", () => {
    expect([...KNOWN_OPS]).toContain("lease.observe");
  });

  it("four targets history-fixture parse with zero unknown op/fault warnings", () => {
    const targets = ["ably", "acp-mux", "claude-agent-acp", "vscode-agent-host"];
    const failures: string[] = [];
    for (const t of targets) {
      const hist = path.join(repo_root, "targets", t, "results", "history-fixture.jsonl");
      const warnings: string[] = [];
      load_history_file(hist, { warn: (m) => warnings.push(m) });
      const unknown = warnings.filter((w) => /unknown (op|fault)/.test(w));
      if (unknown.length > 0) {
        failures.push(`${t}: ${unknown.join(" | ")}`);
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });
});
