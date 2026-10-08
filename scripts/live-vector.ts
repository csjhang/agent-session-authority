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
 * - Scenario names starting with `auth08-` are always listed in `excluded` (even when valid) and
 *   never enter `included`, so they cannot shift AUTH-01–07 aggregation.
 * - AUTH-08 (when cfg.auth08 is set and AUTH-08 is not in cfg.exclusions) is computed only from the
 *   valid `auth08-*` runs (`auth08_live_runs`), checked with the assessment's
 *   auth08.enforcement_point and the target's disclosures.json loaded. Its own rules: a scenario
 *   whose runs disagree → listed in auth08_live_runs.disagreements and AUTH-08 inconclusive; else
 *   any run violation → violation; else any run inconclusive → inconclusive; supported only when
 *   every run is supported (otherwise inconclusive; not_tested when no run examined AUTH-08).
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
import type { Auth08Disclosures } from "../packages/core/src/auth08_disclosures.js";
import { list_live_run_dirs } from "../packages/adapters/acp/src/live_run_dirs.js";

/** Exact reason when an auth08-* scenario run is barred from AUTH-01–07 aggregation. */
export const AUTH08_LIVE_RUN_EXCLUDE_REASON =
  "AUTH-08 probe scenario: used only as AUTH-08 evidence (some probes run under probe-chosen permission settings)";


export interface Auth08LiveConfig {
  /** Repo-relative disclosures.json loaded when checking AUTH-08 on the auth08-* runs. */
  disclosures: string;
}

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
  /** AUTH-08 from the auth08-* probe runs only (see module rules); absent = no AUTH-08 channel. */
  auth08?: Auth08LiveConfig;
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

/** auth08-* runs used only for AUTH-08; each included run's observed holds only AUTH-08. */
export interface Auth08LiveRuns {
  included: IncludedRun[];
  excluded: ExcludedRun[];
  disagreements: Disagreement[];
}

export interface LiveVector {
  capability_basis: TestBasis | null;
  capability_vector: Record<string, ResultLabel>;
  observed_vector: Record<string, ResultLabel>;
  capability_sources: Record<string, string[]>;
  capability_exclusions: Record<string, string>;
  live_runs: { included: IncludedRun[]; excluded: ExcludedRun[]; disagreements: Disagreement[] };
  /** Present only when the target has an AUTH-08 live channel (cfg.auth08). */
  auth08_live_runs?: Auth08LiveRuns;
}

/** Inputs for checking AUTH-08 on the auth08-* runs. */
export interface Auth08RunSetup {
  /** assessment.auth08.enforcement_point; absent → every run is AUTH-08 not_tested (NT_SETUP). */
  enforcement_point?: string;
  /** Loaded disclosures.json; absent → observed bypasses are inconclusive (checker rule). */
  disclosures?: Auth08Disclosures;
}

const rel = (repo_root: string, p: string) => path.relative(repo_root, p).split(path.sep).join("/");

/** run.json admissibility: run_valid=true and package_version_observed equals the pin. */
function manifest_reasons(run_dir: string, cfg: LiveConfig): string[] {
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
  return reasons;
}

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
    if (scenario.startsWith("auth08-")) {
      excluded.push({ scenario, run_id, reasons: [AUTH08_LIVE_RUN_EXCLUDE_REASON] });
      continue;
    }
    const reasons = manifest_reasons(run_dir, cfg);
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

/**
 * Read the auth08-* run folders only; each valid run is checked for AUTH-08 with the given
 * enforcement point and disclosures. Same admissibility rules as load_live_runs; rejected
 * entries under an auth08-* scenario name are listed here as well.
 */
export function load_auth08_live_runs(
  runs_root: string,
  repo_root: string,
  cfg: LiveConfig,
  target: string,
  setup: Auth08RunSetup,
): { included: IncludedRun[]; excluded: ExcludedRun[] } {
  const included: IncludedRun[] = [];
  const excluded: ExcludedRun[] = [];
  for (const entry of list_live_run_dirs(runs_root)) {
    if (!entry.scenario.startsWith("auth08-")) continue;
    if (entry.kind === "rejected") {
      excluded.push({ scenario: entry.scenario, run_id: entry.run_id ?? "*", reasons: [entry.reason] });
      continue;
    }
    const { scenario, run_id, dir: run_dir } = entry;
    const reasons = manifest_reasons(run_dir, cfg);
    const history_path = path.join(run_dir, "history.jsonl");
    let label: ResultLabel | undefined;
    if (!fs.existsSync(history_path)) {
      reasons.push("history.jsonl missing");
    } else if (reasons.length === 0) {
      try {
        const events = load_history_file(history_path, { warn_unknown_vocab: false });
        const findings = run_checkers(
          events,
          null,
          {
            target,
            test_basis: cfg.test_basis,
            ...(setup.enforcement_point !== undefined ? { auth08: { enforcement_point: setup.enforcement_point } } : {}),
          },
          { auth08_disclosures: setup.disclosures },
        );
        label = findings.find((f) => f.invariant === "AUTH-08")?.observed_result;
      } catch (err) {
        reasons.push(`history.jsonl unreadable: ${String(err instanceof Error ? err.message : err)}`);
      }
    }
    if (reasons.length > 0 || label === undefined) {
      excluded.push({ scenario, run_id, reasons });
    } else {
      included.push({ scenario, run_id, history: rel(repo_root, history_path), observed: { "AUTH-08": label } });
    }
  }
  return { included, excluded };
}

/**
 * AUTH-08 across the auth08-* runs (rules differ from aggregate_live):
 * 1. a scenario whose runs disagree → disagreements, AUTH-08 inconclusive (sources: those runs);
 * 2. else any run violation → violation (sources: violating runs);
 * 3. else any run inconclusive → inconclusive (sources: inconclusive runs);
 * 4. else every run supported → supported (sources: all runs);
 * otherwise (a mix of supported and not_tested) inconclusive over the examined runs, and
 * not_tested when no run examined AUTH-08.
 */
export function aggregate_auth08(included: IncludedRun[]): {
  observed: ResultLabel;
  sources: string[];
  disagreements: Disagreement[];
} {
  const inv = "AUTH-08";
  const label_of = (r: IncludedRun): ResultLabel => r.observed[inv] ?? "not_tested";
  const disagreements: Disagreement[] = [];
  for (const scenario of [...new Set(included.map((r) => r.scenario))].sort()) {
    const runs = included.filter((r) => r.scenario === scenario);
    if (new Set(runs.map(label_of)).size > 1) {
      disagreements.push({ invariant: inv, scenario, runs: Object.fromEntries(runs.map((r) => [r.run_id, label_of(r)])) });
    }
  }
  const histories = (runs: IncludedRun[]) => runs.map((r) => r.history);
  if (disagreements.length > 0) {
    const split = new Set(disagreements.map((d) => d.scenario));
    return { observed: "inconclusive", sources: histories(included.filter((r) => split.has(r.scenario))), disagreements };
  }
  const with_label = (l: ResultLabel) => included.filter((r) => label_of(r) === l);
  if (with_label("violation").length > 0) return { observed: "violation", sources: histories(with_label("violation")), disagreements };
  if (with_label("inconclusive").length > 0) {
    return { observed: "inconclusive", sources: histories(with_label("inconclusive")), disagreements };
  }
  const examined = included.filter((r) => label_of(r) !== "not_tested");
  if (examined.length === 0) return { observed: "not_tested", sources: [], disagreements };
  if (examined.length === included.length && included.every((r) => label_of(r) === "supported")) {
    return { observed: "supported", sources: histories(included), disagreements };
  }
  return { observed: "inconclusive", sources: histories(examined), disagreements };
}

/** Aggregate included runs into observed/capability vectors (see module rules). */
export function aggregate_live(
  included: IncludedRun[],
  excluded: ExcludedRun[],
  cfg: LiveConfig,
  auth08_runs?: { included: IncludedRun[]; excluded: ExcludedRun[] },
): LiveVector {
  const observed_vector: Record<string, ResultLabel> = {};
  const capability_vector: Record<string, ResultLabel> = {};
  const capability_sources: Record<string, string[]> = {};
  const disagreements: Disagreement[] = [];
  const scenarios = [...new Set(included.map((r) => r.scenario))].sort();
  const auth08_channel = cfg.auth08 !== undefined && cfg.exclusions["AUTH-08"] === undefined;
  let auth08_live_runs: Auth08LiveRuns | undefined;

  for (const inv of KNOWN_INVARIANTS) {
    if (inv === "AUTH-08" && auth08_channel) {
      const a = auth08_runs ?? { included: [], excluded: [] };
      const agg = aggregate_auth08(a.included);
      auth08_live_runs = { included: a.included, excluded: a.excluded, disagreements: agg.disagreements };
      observed_vector[inv] = agg.observed;
      capability_vector[inv] = finding(inv, "not_declared", agg.observed, "", [], cfg.test_basis).result;
      if (capability_vector[inv] !== "not_tested") capability_sources[inv] = agg.sources;
      continue;
    }
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

  const any_included = included.length > 0 || (auth08_live_runs?.included.length ?? 0) > 0;
  return {
    capability_basis: any_included ? cfg.test_basis : null,
    capability_vector,
    observed_vector,
    capability_sources,
    capability_exclusions: { ...cfg.exclusions },
    live_runs: { included, excluded, disagreements },
    ...(auth08_live_runs ? { auth08_live_runs } : {}),
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
