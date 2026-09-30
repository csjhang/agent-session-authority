#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collect_history, type AdapterMode, type AdapterScenario } from "./index.js";
import { RUN_ID_PATTERN, write_live_run } from "./live_output.js";

const args = process.argv.slice(2);
let mode: AdapterMode = "fixture";
let scenario: AdapterScenario = "initialize";
const mode_idx = args.indexOf("--mode");
if (mode_idx >= 0 && args[mode_idx + 1]) mode = args[mode_idx + 1] === "live" ? "live" : "fixture";
const scenario_idx = args.indexOf("--scenario");
if (scenario_idx >= 0 && args[scenario_idx + 1]) {
  const raw = args[scenario_idx + 1];
  scenario =
    raw === "capped" ? "capped"
    : raw === "effect" ? "effect"
    : raw === "stale-grant" ? "stale-grant"
    : raw === "stale-effect" ? "stale-effect"
    : raw === "always-grant" ? "always-grant"
    : raw === "reject-always" ? "reject-always"
    : raw === "mid-write-restart" ? "mid-write-restart"
    : "initialize";
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repo_root = path.resolve(here, "../../../..");
const default_live_out = path.join(repo_root, "targets/claude-agent-acp/results/live-runs");

const run_id_idx = args.indexOf("--run-id");
let run_id = `${Date.now()}-${process.pid}`;
if (run_id_idx >= 0 && args[run_id_idx + 1]) run_id = args[run_id_idx + 1]!;
const out_dir_idx = args.indexOf("--out-dir");
let out_dir = default_live_out;
if (out_dir_idx >= 0 && args[out_dir_idx + 1]) out_dir = path.resolve(args[out_dir_idx + 1]!);

if (mode === "live" && !RUN_ID_PATTERN.test(run_id)) {
  console.error(`invalid --run-id ${JSON.stringify(run_id)}: must match ${RUN_ID_PATTERN}`);
  process.exit(2);
}

const result = await collect_history({ mode, scenario });

if (mode === "live") {
  try {
    const run_dir = write_live_run(result, {
      out_root: out_dir,
      scenario,
      run_id,
      env: process.env,
    });
    console.log(JSON.stringify({
      mode: result.mode,
      scenario,
      run_id,
      run_dir,
      run_valid: result.run_valid,
      invalid_reasons: result.invalid_reasons,
      package_version_observed: result.package_version_observed ?? null,
      notes: result.notes,
      events: result.events.length,
    }, null, 2));
    process.exit(result.run_valid ? 0 : 2);
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(2);
  }
}

const fixture_out_dir = path.join(repo_root, "targets/claude-agent-acp/results");
fs.mkdirSync(fixture_out_dir, { recursive: true });
const hist_name = scenario === "effect"
  ? "history-" + result.mode + "-effect.jsonl"
  : scenario === "stale-grant"
    ? "history-" + result.mode + "-stale-grant.jsonl"
  : scenario === "stale-effect"
    ? "history-" + result.mode + "-stale-effect.jsonl"
  : scenario === "always-grant"
    ? "history-" + result.mode + "-always-grant.jsonl"
  : scenario === "reject-always"
    ? "history-" + result.mode + "-reject-always.jsonl"
  : scenario === "mid-write-restart"
    ? "history-" + result.mode + "-mid-write-restart.jsonl"
  : "history-" + result.mode + ".jsonl";
const hist_path = path.join(fixture_out_dir, hist_name);
fs.writeFileSync(hist_path, result.history_jsonl);
console.log(JSON.stringify({ mode: result.mode, scenario, history_path: hist_path, notes: result.notes, events: result.events.length }, null, 2));
