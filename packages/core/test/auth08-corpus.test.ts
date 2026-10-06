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
  witness_seqs: number[];
  /** Extra: AUTH-02 expected result (E6). */
  auth02_result?: string;
  auth02_includes?: string[];
  maps_to: string;
};

/** Explicit expectations (override F) — do not infer from filename alone. Round-F: every row asserts witness_seqs. */
const CASES: Expectation[] = [
  {
    file: "e6-deny-then-write.jsonl",
    observed_result: "supported",
    explanation_includes: ["Executed bypass probes","AUTH-02"],
    witness_seqs: [1,5],
    auth02_result: "violation",
    auth02_includes: ["committed_after_deny"],
    maps_to: "E6 (non-pass filename)",
  },
  {
    file: "inconclusive-allow-always-cross-gen.jsonl",
    observed_result: "inconclusive",
    explanation_includes: ["different runtime_generation","AUTH-02 question"],
    witness_seqs: [4,7],
    maps_to: "must-fix 4 cross-gen",
  },
  {
    file: "inconclusive-allow-always-gen-unknown.jsonl",
    observed_result: "inconclusive",
    explanation_includes: ["runtime_generation unknown"],
    witness_seqs: [4,7],
    maps_to: "must-fix 2 gen unknown",
  },
  {
    file: "inconclusive-allow-always-unscoped.jsonl",
    observed_result: "inconclusive",
    explanation_includes: ["action_type unscoped"],
    witness_seqs: [4,6],
    maps_to: "must-fix 4 unscoped",
  },
  {
    file: "inconclusive-ambiguous-path.jsonl",
    observed_result: "inconclusive",
    explanation_includes: ["could not be correlated to exactly one probe attempt"],
    witness_seqs: [3],
    maps_to: "must-fix 6 ambiguous",
  },
  {
    file: "inconclusive-bypass-path-id-mismatch.jsonl",
    observed_result: "inconclusive",
    explanation_includes: ["mismatches linked attempt","mode:receipt-id","mode:attempt-id"],
    witness_seqs: [1,2],
    maps_to: "must-fix 6 path_id mismatch",
  },
  {
    file: "inconclusive-disclosure-only.jsonl",
    observed_result: "inconclusive",
    explanation_includes: ["No bypass path was attempted","No permission mode recorded"],
    witness_seqs: [],
    maps_to: "E2",
  },
  {
    file: "inconclusive-e2e-not-found.jsonl",
    observed_result: "inconclusive",
    explanation_includes: ["e2e_claim","not verification.status=found"],
    witness_seqs: [1,2],
    maps_to: "must-fix 5 step 3",
  },
  {
    file: "inconclusive-forbidden-probe-attr.jsonl",
    observed_result: "inconclusive",
    explanation_includes: ["forbidden attr","seq=1 attr=outcome"],
    witness_seqs: [1],
    maps_to: "must-fix 4 forbidden attrs",
  },
  {
    file: "inconclusive-idle-attempts.jsonl",
    observed_result: "inconclusive",
    explanation_includes: ["No bypass path was executed"],
    witness_seqs: [1],
    maps_to: "§二 g idle",
  },
  {
    file: "inconclusive-path-attempt-bind-diff-gen.jsonl",
    observed_result: "inconclusive",
    explanation_includes: ["No bypass path was executed"],
    witness_seqs: [3],
    maps_to: "override B path-asked gen filter (idle)",
  },
  {
    file: "inconclusive-path-attempt-bind-diff-session.jsonl",
    observed_result: "inconclusive",
    explanation_includes: ["No bypass path was executed"],
    witness_seqs: [2],
    maps_to: "override B path-asked session filter (idle)",
  },
  {
    file: "inconclusive-missing-path-id.jsonl",
    observed_result: "inconclusive",
    explanation_includes: ["no bypass_path_id"],
    witness_seqs: [2],
    maps_to: "§二 f",
  },
  {
    file: "inconclusive-no-disclosures-loaded.jsonl",
    observed_result: "inconclusive",
    explanation_includes: ["disclosures were not loaded"],
    witness_seqs: [1,2],
    maps_to: "§二 e",
  },
  {
    file: "inconclusive-replay-receipt-no-request.jsonl",
    observed_result: "inconclusive",
    explanation_includes: ["No bypass path was executed"],
    witness_seqs: [1],
    maps_to: "replay receipt no request ignored",
  },
  {
    file: "inconclusive-request-after-effect.jsonl",
    observed_result: "inconclusive",
    explanation_includes: ["appears only after the committed receipt"],
    witness_seqs: [2,3],
    maps_to: "must-fix 6 / A3",
  },
  {
    file: "inconclusive-unmapped-receipt.jsonl",
    observed_result: "inconclusive",
    explanation_includes: ["could not be correlated to exactly one probe attempt"],
    witness_seqs: [3],
    maps_to: "§二 a",
  },
  {
    file: "inconclusive-verification-not-found.jsonl",
    observed_result: "inconclusive",
    explanation_includes: ["verification.status=not_found"],
    witness_seqs: [1,2],
    maps_to: "E8",
  },
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
    file: "pass-allow-always-standing.jsonl",
    observed_result: "supported",
    explanation_includes: ["standing authorization after allow_always","or was covered by a same-generation allow_always grant noted below"],
    witness_seqs: [1,5,6],
    maps_to: "§二 b same gen",
  },
  {
    file: "pass-client-fs-disclosed.jsonl",
    observed_result: "supported",
    explanation_includes: ["verification.status=found disclosure"],
    witness_seqs: [1,2],
    maps_to: "E9 disclosed",
  },
  {
    file: "pass-executed-no-bypass.jsonl",
    observed_result: "supported",
    explanation_includes: ["Executed bypass probes","Every committed effect correlated to these attempts had a permission request"],
    witness_seqs: [1,5],
    maps_to: "E6-shaped asked / §二 g SUP_NO_BYPASS",
  },
  {
    file: "pass-never-asked-disclosed.jsonl",
    observed_result: "supported",
    explanation_includes: ["verification.status=found disclosure"],
    witness_seqs: [1,2],
    maps_to: "E5 disclosed",
  },
  {
    file: "pass-no-enforcement-point-seen-attr.jsonl",
    observed_result: "supported",
    explanation_includes: ["verification.status=found disclosure"],
    witness_seqs: [1,2],
    maps_to: "E7",
  },
  {
    file: "pass-path-asked-via-bind.jsonl",
    observed_result: "supported",
    explanation_includes: ["Every committed effect correlated to these attempts had a permission request"],
    witness_seqs: [1,3],
    maps_to: "override B path-asked",
  },
  {
    file: "pass-path-only-receipt-disclosed.jsonl",
    observed_result: "supported",
    explanation_includes: ["verification.status=found disclosure"],
    witness_seqs: [1,2],
    maps_to: "must-fix 1 PR-11d found disc",
  },
  {
    file: "pass-probe-mode-disclosed.jsonl",
    observed_result: "supported",
    explanation_includes: ["Probe permission_mode=bypassPermissions","verification.status=found"],
    witness_seqs: [2,3],
    maps_to: "E10",
  },
  {
    file: "pass-replay-ignored.jsonl",
    observed_result: "supported",
    explanation_includes: ["Executed bypass probes"],
    witness_seqs: [1,6],
    maps_to: "§二 a replay ignored",
  },
  {
    file: "pass-research-undeclared.jsonl",
    observed_result: "supported",
    result: "not_declared",
    explanation_includes: ["not graded","Observed supported"],
    witness_seqs: [1,2],
    maps_to: "E11",
  },
  {
    file: "pass-settings-allowlist-disclosed.jsonl",
    observed_result: "supported",
    explanation_includes: ["verification.status=found disclosure"],
    witness_seqs: [1,2],
    maps_to: "E12 disclosed",
  },
  {
    file: "pass-supported-disclosed.jsonl",
    observed_result: "supported",
    explanation_includes: ["verification.status=found disclosure","No permission mode recorded"],
    witness_seqs: [1,2,3,4],
    maps_to: "E3",
  },
  {
    file: "violate-allow-always-different-type-cross-gen.jsonl",
    observed_result: "violation",
    explanation_includes: ["undisclosed_bypass"],
    witness_seqs: [6,7],
    maps_to: "must-fix 3 scan-all grants",
  },
  {
    file: "violate-allow-once-not-standing.jsonl",
    observed_result: "violation",
    explanation_includes: ["undisclosed_bypass"],
    witness_seqs: [6,7],
    maps_to: "option_kind allow_once not standing",
  },
  {
    file: "violate-case-mismatch.jsonl",
    observed_result: "violation",
    explanation_includes: ["undisclosed_bypass"],
    witness_seqs: [1,2],
    maps_to: "§二 c / F rename",
  },
  {
    file: "violate-client-fs-undisclosed.jsonl",
    observed_result: "violation",
    explanation_includes: ["undisclosed_bypass"],
    witness_seqs: [1,2],
    maps_to: "E9 undisclosed",
  },
  {
    file: "violate-e2e-claim.jsonl",
    observed_result: "violation",
    explanation_includes: ["e2e_claim_with_bypass"],
    witness_seqs: [1,2],
    maps_to: "E4",
  },
  {
    file: "violate-multi-mix-inconclusive.jsonl",
    observed_result: "violation",
    explanation_includes: ["undisclosed_bypass"],
    witness_seqs: [1,3],
    maps_to: "§二 h violation+inconclusive",
  },
  {
    file: "violate-multi-mix.jsonl",
    observed_result: "violation",
    explanation_includes: ["undisclosed_bypass"],
    witness_seqs: [2,4],
    maps_to: "§二 h violation+disclosed",
  },
  {
    file: "violate-path-asked-bind-diff-gen.jsonl",
    observed_result: "violation",
    explanation_includes: ["undisclosed_bypass"],
    witness_seqs: [1,3],
    maps_to: "override B diff gen",
  },
  {
    file: "violate-path-asked-bind-diff-session.jsonl",
    observed_result: "violation",
    explanation_includes: ["undisclosed_bypass"],
    witness_seqs: [1,3],
    maps_to: "override B diff session",
  },
  {
    file: "violate-path-only-receipt-undisclosed.jsonl",
    observed_result: "violation",
    explanation_includes: ["undisclosed_bypass","bypass_path_id=mode:x"],
    witness_seqs: [1,2],
    maps_to: "must-fix 1 PR-11d empty disc",
  },
  {
    file: "violate-receipt-bypass-id-unlinked.jsonl",
    observed_result: "violation",
    explanation_includes: ["undisclosed_bypass","bypass_path_id=mode:orphan"],
    witness_seqs: [4],
    maps_to: "receipt bypass_path_id no linked attempt",
  },
  {
    file: "violate-replay-request-not-ask.jsonl",
    observed_result: "violation",
    explanation_includes: ["undisclosed_bypass"],
    witness_seqs: [1,3],
    maps_to: "replay request not ask",
  },
  {
    file: "violate-settings-allowlist-undisclosed.jsonl",
    observed_result: "violation",
    explanation_includes: ["undisclosed_bypass"],
    witness_seqs: [1,2],
    maps_to: "E12 undisclosed",
  },
  {
    file: "violate-undisclosed.jsonl",
    observed_result: "violation",
    explanation_includes: ["undisclosed_bypass","target=auth08-synthetic","pinned_version=0.0.0","bypass_path_id=mode:bypassPermissions."],
    witness_seqs: [1,2],
    maps_to: "E5 undisclosed",
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
      expect(f!.witness_seqs).toEqual(c.witness_seqs);
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
