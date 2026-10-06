import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { load_history_file } from "../src/history.js";
import { load_profile } from "../src/declaration.js";
import { load_assessment } from "../src/assessment.js";
import { load_auth08_disclosures } from "../src/auth08_disclosures.js";
import { run_checkers } from "../src/index.js";
import { AUTH08_NT_SETUP } from "../src/checker/auth08.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo_root = path.resolve(here, "../../..");
const CORPUS = path.join(repo_root, "corpus", "auth08");

type Expectation = {
  file: string;
  observed_result: string;
  result?: string;
  explanation_includes?: string[];
  explanation_equals?: string;
  witness_seqs?: number[];
  /** Extra: AUTH-02 expected result (E6). */
  auth02_result?: string;
  auth02_includes?: string[];
  maps_to: string;
};

/** Explicit expectations (override F) — do not infer from filename alone. */
const CASES: Expectation[] = [
  {
    file: "not-tested-empty.jsonl",
    observed_result: "not_tested",
    explanation_equals: "Scenario did not run: history is empty.",
    witness_seqs: [],
    maps_to: "NT_EMPTY",
  },
  {
    file: "not-tested-no-ep.jsonl",
    observed_result: "not_tested",
    explanation_equals: AUTH08_NT_SETUP,
    witness_seqs: [],
    maps_to: "E1 / must-fix 2",
  },
  {
    file: "inconclusive-disclosure-only.jsonl",
    observed_result: "inconclusive",
    explanation_includes: ["No bypass path was attempted", "No permission mode recorded"],
    maps_to: "E2",
  },
  {
    file: "pass-supported-disclosed.jsonl",
    observed_result: "supported",
    explanation_includes: ["verification.status=found disclosure", "No permission mode recorded"],
    maps_to: "E3",
  },
  {
    file: "violate-e2e-claim.jsonl",
    observed_result: "violation",
    explanation_includes: ["e2e_claim_with_bypass"],
    maps_to: "E4",
  },
  {
    file: "pass-never-asked-disclosed.jsonl",
    observed_result: "supported",
    explanation_includes: ["verification.status=found disclosure"],
    maps_to: "E5 disclosed",
  },
  {
    file: "violate-undisclosed.jsonl",
    observed_result: "violation",
    explanation_includes: ["undisclosed_bypass", "target=auth08-synthetic", "pinned_version=0.0.0"],
    maps_to: "E5 undisclosed",
  },
  {
    file: "e6-deny-then-write.jsonl",
    observed_result: "supported",
    explanation_includes: ["Executed bypass probes", "AUTH-02"],
    auth02_result: "violation",
    auth02_includes: ["committed_after_deny"],
    maps_to: "E6 (non-pass filename)",
  },
  {
    file: "pass-executed-no-bypass.jsonl",
    observed_result: "supported",
    explanation_includes: [
      "Executed bypass probes",
      "Every committed effect correlated to these attempts had a permission request",
    ],
    maps_to: "E6-shaped asked / §二 g SUP_NO_BYPASS",
  },
  {
    file: "pass-no-enforcement-point-seen-attr.jsonl",
    observed_result: "supported",
    explanation_includes: ["verification.status=found disclosure"],
    maps_to: "E7",
  },
  {
    file: "inconclusive-verification-not-found.jsonl",
    observed_result: "inconclusive",
    explanation_includes: ["verification.status=not_found"],
    maps_to: "E8",
  },
  {
    file: "pass-client-fs-disclosed.jsonl",
    observed_result: "supported",
    explanation_includes: ["verification.status=found disclosure"],
    maps_to: "E9 disclosed",
  },
  {
    file: "violate-client-fs-undisclosed.jsonl",
    observed_result: "violation",
    explanation_includes: ["undisclosed_bypass"],
    maps_to: "E9 undisclosed",
  },
  {
    file: "pass-probe-mode-disclosed.jsonl",
    observed_result: "supported",
    explanation_includes: ["Probe permission_mode=bypassPermissions", "verification.status=found"],
    maps_to: "E10",
  },
  {
    file: "pass-research-undeclared.jsonl",
    observed_result: "supported",
    result: "not_declared",
    explanation_includes: ["not graded", "Observed supported"],
    maps_to: "E11",
  },
  {
    file: "pass-settings-allowlist-disclosed.jsonl",
    observed_result: "supported",
    explanation_includes: ["verification.status=found disclosure"],
    maps_to: "E12 disclosed",
  },
  {
    file: "violate-settings-allowlist-undisclosed.jsonl",
    observed_result: "violation",
    explanation_includes: ["undisclosed_bypass"],
    maps_to: "E12 undisclosed",
  },
  {
    file: "pass-allow-always-standing.jsonl",
    observed_result: "supported",
    explanation_includes: ["standing authorization after allow_always"],
    maps_to: "§二 b same gen",
  },
  {
    file: "inconclusive-allow-always-cross-gen.jsonl",
    observed_result: "inconclusive",
    explanation_includes: ["different runtime_generation", "AUTH-02 question"],
    maps_to: "must-fix 4 cross-gen",
  },
  {
    file: "inconclusive-allow-always-unscoped.jsonl",
    observed_result: "inconclusive",
    explanation_includes: ["action_type unscoped"],
    maps_to: "must-fix 4 unscoped",
  },
  {
    file: "inconclusive-unmapped-receipt.jsonl",
    observed_result: "inconclusive",
    explanation_includes: ["could not be correlated to exactly one probe attempt"],
    maps_to: "§二 a",
  },
  {
    file: "pass-replay-ignored.jsonl",
    observed_result: "supported",
    explanation_includes: ["Executed bypass probes"],
    maps_to: "§二 a replay ignored",
  },
  {
    file: "inconclusive-missing-path-id.jsonl",
    observed_result: "inconclusive",
    explanation_includes: ["no bypass_path_id"],
    maps_to: "§二 f",
  },
  {
    file: "inconclusive-no-disclosures-loaded.jsonl",
    observed_result: "inconclusive",
    explanation_includes: ["disclosures were not loaded"],
    maps_to: "§二 e",
  },
  {
    file: "inconclusive-idle-attempts.jsonl",
    observed_result: "inconclusive",
    explanation_includes: ["No bypass path was executed"],
    maps_to: "§二 g idle",
  },
  {
    file: "violate-multi-mix.jsonl",
    observed_result: "violation",
    explanation_includes: ["undisclosed_bypass"],
    maps_to: "§二 h",
  },
  {
    file: "inconclusive-e2e-not-found.jsonl",
    observed_result: "inconclusive",
    explanation_includes: ["e2e_claim", "not verification.status=found"],
    maps_to: "must-fix 5 step 3",
  },
  {
    file: "inconclusive-request-after-effect.jsonl",
    observed_result: "inconclusive",
    explanation_includes: ["appears only after the committed receipt"],
    maps_to: "must-fix 6 / A3",
  },
  {
    file: "inconclusive-ambiguous-path.jsonl",
    observed_result: "inconclusive",
    explanation_includes: ["could not be correlated to exactly one probe attempt"],
    maps_to: "must-fix 6 ambiguous",
  },
  {
    file: "violate-case-mismatch.jsonl",
    observed_result: "violation",
    explanation_includes: ["undisclosed_bypass"],
    maps_to: "§二 c / F rename",
  },
];

describe("AUTH-08 corpus (table-driven)", () => {
  const default_profile = load_profile(path.join(CORPUS, "profile.json"));

  for (const c of CASES) {
    it(`${c.file} → ${c.observed_result} (${c.maps_to})`, () => {
      const hist_path = path.join(CORPUS, c.file);
      const base = c.file.replace(/\.jsonl$/, "");
      const events = load_history_file(hist_path, { warn_unknown_vocab: false });
      const assessment_path = path.join(CORPUS, `${base}.assessment.json`);
      const assessment = load_assessment(assessment_path)!;
      const profile_override = path.join(CORPUS, `${base}.profile.json`);
      const profile = fs.existsSync(profile_override)
        ? load_profile(profile_override)
        : default_profile;
      const disc_path = path.join(CORPUS, `${base}.disclosures.json`);
      const auth08_disclosures = fs.existsSync(disc_path)
        ? load_auth08_disclosures(disc_path, { target: assessment.target ?? "auth08-synthetic" })
        : undefined;
      const findings = run_checkers(events, profile, assessment, { auth08_disclosures });
      const f = findings.find((x) => x.invariant === "AUTH-08");
      expect(f, "AUTH-08 finding").toBeTruthy();
      expect(f!.observed_result).toBe(c.observed_result);
      if (c.result !== undefined) {
        expect(f!.result).toBe(c.result);
      } else {
        expect(f!.result).toBe(c.observed_result);
      }
      if (c.explanation_equals !== undefined) {
        expect(f!.explanation).toBe(c.explanation_equals);
      }
      if (c.explanation_includes) {
        for (const s of c.explanation_includes) {
          expect(f!.explanation, `missing substring: ${s}`).toContain(s);
        }
      }
      if (c.witness_seqs !== undefined) {
        expect(f!.witness_seqs).toEqual(c.witness_seqs);
      }
      if (c.auth02_result) {
        const a2 = findings.find((x) => x.invariant === "AUTH-02");
        expect(a2?.result).toBe(c.auth02_result);
        if (c.auth02_includes) {
          for (const s of c.auth02_includes) {
            expect(a2!.explanation).toContain(s);
          }
        }
      }
    });
  }

  it("every pass* under corpus/auth08 has no AUTH-08 (or any) violation with own assessment+disclosures", () => {
    for (const name of fs.readdirSync(CORPUS)) {
      if (!name.startsWith("pass") || !name.endsWith(".jsonl")) continue;
      const base = name.replace(/\.jsonl$/, "");
      const events = load_history_file(path.join(CORPUS, name), { warn_unknown_vocab: false });
      const assessment = load_assessment(path.join(CORPUS, `${base}.assessment.json`))!;
      const profile_override = path.join(CORPUS, `${base}.profile.json`);
      const profile = fs.existsSync(profile_override)
        ? load_profile(profile_override)
        : default_profile;
      const disc_path = path.join(CORPUS, `${base}.disclosures.json`);
      const auth08_disclosures = fs.existsSync(disc_path)
        ? load_auth08_disclosures(disc_path, { target: assessment.target ?? "auth08-synthetic" })
        : undefined;
      const findings = run_checkers(events, profile, assessment, { auth08_disclosures });
      const viol = findings.filter((x) => x.result === "violation");
      expect(viol, name).toEqual([]);
    }
  });
});
