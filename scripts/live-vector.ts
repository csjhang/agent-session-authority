/**
 * Live evidence → capability_vector for a target.
 *
 * Layout read: <runs_root>/<scenario>/<run_id>/{history.jsonl, run.json, peer-events.jsonl}
 * (written by the ACP adapter's write_live_run).
 *
 * Rules:
 * - Only real directories are walked at the scenario/run layers (shared list_live_run_dirs);
 *   a symlink or plain file there is listed in `excluded` with the reason (run_id "*" when the
 *   scenario entry itself is not a real directory).
 * - A run counts only when run.json says run_valid=true, package_version_observed equals the
 *   pinned version, and history.jsonl parses. Every other run is listed in `excluded` with reasons.
 * - Each included run is checked with no vendor profile under the target's live test_basis
 *   (research_profile for claude-agent-acp).
 * - Per invariant and scenario, all runs must agree. Disagreement is reported as-is
 *   (never a majority vote) and makes that scenario "inconsistent".
 * - Across scenarios: a consistent violation anywhere → violation; else any inconsistency →
 *   inconclusive; else a consistent supported anywhere → supported; else inconclusive
 *   (when any runs were examined) or not_tested.
 * - Invariants whose live evidence only reflects the probe itself are excluded by an explicit
 *   admissibility rule: observed_vector and capability_vector stay not_tested with the reason.
 * - target_witness: for listed invariants a run's supported counts only when at least one witness
 *   event was reported by the target itself; otherwise that run is inconclusive (see `downgraded`).
 * - capability_vector = claim rewrite of the aggregated observed result via core finding()
 *   (undeclared + research_profile → supported/violation become not_declared).
 */
import fs from "node:fs";
import path from "node:path";
import { load_history_file } from "../packages/core/src/history.js";
import type { HistoryEvent } from "../packages/core/src/history.js";
import { run_checkers } from "../packages/core/src/index.js";
import { finding, KNOWN_INVARIANTS } from "../packages/core/src/checker/index.js";
import type { ResultLabel, TestBasis } from "../packages/core/src/assessment.js";
import { list_live_run_dirs } from "../packages/adapters/acp/src/live_run_dirs.js";

export interface LiveConfig {
  /** Repo-relative directory holding <scenario>/<run_id>/ run folders. */
  runs_dir: string;
  pinned_version: string;
  test_basis: TestBasis;
  /** invariant → reason it can never be promoted from this target's live runs; absent = admissible. */
  exclusions: Record<string, string>;
  /**
   * invariant → a per-run `supported` counts only if at least one of its witness events
   * passes `test`; otherwise that run's result becomes inconclusive with `reason`.
   */
  target_witness?: Record<string, { reason: string; test: (e: HistoryEvent) => boolean }>;
}

export interface IncludedRun {
  scenario: string;
  run_id: string;
  /** Repo-relative (forward slashes) path of history.jsonl. */
  history: string;
  observed: Record<string, ResultLabel>;
  /** invariant → why this run's supported was not counted (only present when non-empty). */
  downgraded?: Record<string, string>;
}

export interface ExcludedRun {
  scenario: string;
  run_id: string;
  reasons: string[];
}

export interface Disagreement {
  invariant: string;
  scenario: string;
  runs: Record<string, ResultLabel>;
}

export interface LiveVector {
  capability_basis: TestBasis | null;
  capability_vector: Record<string, ResultLabel>;
  observed_vector: Record<string, ResultLabel>;
  capability_sources: Record<string, string[]>;
  capability_exclusions: Record<string, string>;
  live_runs: { included: IncludedRun[]; excluded: ExcludedRun[]; disagreements: Disagreement[] };
}

const rel = (repo_root: string, p: string) => path.relative(repo_root, p).split(path.sep).join("/");

/** Read every run folder; split into included (checked) and excluded (with reasons). */
export function load_live_runs(
  runs_root: string,
  repo_root: string,
  cfg: LiveConfig,
  target: string,
): { included: IncludedRun[]; excluded: ExcludedRun[] } {
  const included: IncludedRun[] = [];
  const excluded: ExcludedRun[] = [];
  for (const entry of list_live_run_dirs(runs_root)) {
    if (entry.kind === "rejected") {
      // Symlink / plain file at the scenario or run layer: never followed, never silent.
      excluded.push({ scenario: entry.scenario, run_id: entry.run_id ?? "*", reasons: [entry.reason] });
      continue;
    }
    const { scenario, run_id, dir: run_dir } = entry;
    const reasons: string[] = [];
    let manifest: Record<string, unknown> | undefined;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(run_dir, "run.json"), "utf8")) as Record<string, unknown>;
    } catch (err) {
      reasons.push(`run.json unreadable: ${String(err instanceof Error ? err.message : err)}`);
    }
    if (manifest) {
      if (manifest.run_valid !== true) {
        const why = Array.isArray(manifest.invalid_reasons) ? manifest.invalid_reasons.join("; ") : "";
        reasons.push(`run_valid is not true${why ? `: ${why}` : ""}`);
      }
      if (manifest.package_version_observed !== cfg.pinned_version) {
        reasons.push(`package_version_observed=${String(manifest.package_version_observed)} != pinned ${cfg.pinned_version}`);
      }
    }
    const history_path = path.join(run_dir, "history.jsonl");
    let observed: Record<string, ResultLabel> | undefined;
    const downgraded: Record<string, string> = {};
    if (!fs.existsSync(history_path)) {
      reasons.push("history.jsonl missing");
    } else if (reasons.length === 0) {
      try {
        const events = load_history_file(history_path, { warn_unknown_vocab: false });
        const findings = run_checkers(events, null, { target, test_basis: cfg.test_basis });
        observed = Object.fromEntries(findings.map((f) => [f.invariant, f.observed_result]));
        const by_seq = new Map(events.map((e) => [e.seq, e]));
        for (const [inv, rule] of Object.entries(cfg.target_witness ?? {})) {
          const f = findings.find((x) => x.invariant === inv);
          if (!f || f.observed_result !== "supported") continue;
          if (f.witness_seqs.some((s) => { const e = by_seq.get(s); return e !== undefined && rule.test(e); })) continue;
          observed[inv] = "inconclusive";
          downgraded[inv] = rule.reason;
        }
      } catch (err) {
        reasons.push(`history.jsonl unreadable: ${String(err instanceof Error ? err.message : err)}`);
      }
    }
    if (reasons.length > 0 || !observed) {
      excluded.push({ scenario, run_id, reasons });
    } else {
      included.push({
        scenario,
        run_id,
        history: rel(repo_root, history_path),
        observed,
        ...(Object.keys(downgraded).length > 0 ? { downgraded } : {}),
      });
    }
  }
  return { included, excluded };
}

/** Aggregate included runs into observed/capability vectors (see module rules). */
export function aggregate_live(included: IncludedRun[], excluded: ExcludedRun[], cfg: LiveConfig): LiveVector {
  const observed_vector: Record<string, ResultLabel> = {};
  const capability_vector: Record<string, ResultLabel> = {};
  const capability_sources: Record<string, string[]> = {};
  const disagreements: Disagreement[] = [];
  const scenarios = [...new Set(included.map((r) => r.scenario))].sort();

  for (const inv of KNOWN_INVARIANTS) {
    if (cfg.exclusions[inv] !== undefined || included.length === 0) {
      observed_vector[inv] = "not_tested";
      capability_vector[inv] = "not_tested";
      continue;
    }
    // Per scenario: unanimous label, or "inconsistent" (reported, never majority-voted).
    const per_scenario = new Map<string, { label: ResultLabel | "inconsistent"; runs: IncludedRun[] }>();
    for (const scenario of scenarios) {
      const runs = included.filter((r) => r.scenario === scenario);
      const labels = new Set(runs.map((r) => r.observed[inv] ?? "not_tested"));
      if (labels.size === 1) {
        per_scenario.set(scenario, { label: [...labels][0]!, runs });
      } else {
        per_scenario.set(scenario, { label: "inconsistent", runs });
        disagreements.push({
          invariant: inv,
          scenario,
          runs: Object.fromEntries(runs.map((r) => [r.run_id, r.observed[inv] ?? "not_tested"])),
        });
      }
    }
    const pick = (label: ResultLabel | "inconsistent") =>
      [...per_scenario.values()].filter((s) => s.label === label).flatMap((s) => s.runs.map((r) => r.history));
    let observed: ResultLabel;
    let sources: string[];
    if (pick("violation").length > 0) {
      observed = "violation";
      sources = pick("violation");
    } else if (pick("inconsistent").length > 0) {
      observed = "inconclusive";
      sources = pick("inconsistent");
    } else if (pick("supported").length > 0) {
      observed = "supported";
      sources = pick("supported");
    } else {
      const examined = [...per_scenario.values()].filter((s) => s.label !== "not_tested").flatMap((s) => s.runs.map((r) => r.history));
      observed = examined.length > 0 ? "inconclusive" : "not_tested";
      sources = examined;
    }
    observed_vector[inv] = observed;
    // Claim rewrite through core finding(): no vendor profile → claim_status not_declared.
    capability_vector[inv] = finding(inv, "not_declared", observed, "", [], cfg.test_basis).result;
    if (capability_vector[inv] !== "not_tested") capability_sources[inv] = sources;
  }

  return {
    capability_basis: included.length > 0 ? cfg.test_basis : null,
    capability_vector,
    observed_vector,
    capability_sources,
    capability_exclusions: { ...cfg.exclusions },
    live_runs: { included, excluded, disagreements },
  };
}

/** Vector block for a target without live configuration (no live evidence path). */
export function no_live_vector(): LiveVector {
  const nt = Object.fromEntries(KNOWN_INVARIANTS.map((k) => [k, "not_tested" as ResultLabel]));
  return {
    capability_basis: null,
    capability_vector: { ...nt },
    observed_vector: { ...nt },
    capability_sources: {},
    capability_exclusions: {},
    live_runs: { included: [], excluded: [], disagreements: [] },
  };
}
