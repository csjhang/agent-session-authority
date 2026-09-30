/**
 * Offline check / rewrite of committed live-runs history.jsonl from peer-events.jsonl.
 * No live spawn, no API. Default root: targets/claude-agent-acp/results/live-runs.
 *
 * Usage:
 *   pnpm reconvert:live-runs
 *   pnpm reconvert:live-runs -- --write
 *   pnpm reconvert:live-runs -- --runs-root /path/to/live-runs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { check_live_runs, write_live_runs } from "../packages/adapters/acp/src/live_reconvert.js";

const repo_root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_RUNS_ROOT = path.join(repo_root, "targets/claude-agent-acp/results/live-runs");

function usage_err(msg: string): never {
  process.stderr.write(msg + "\n");
  process.exitCode = 2;
  throw new Error(msg);
}

function parse_args(argv: string[]): { write: boolean; runs_root: string } {
  let write = false;
  let runs_root: string | undefined;
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") continue; // ignore lone "--" (pnpm forwards)
    if (a === "--write") {
      write = true;
      continue;
    }
    if (a === "--runs-root") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        usage_err("missing value for --runs-root");
      }
      runs_root = path.resolve(process.cwd(), next!);
      i++;
      continue;
    }
    usage_err(`unknown argument: ${a}`);
  }
  return { write, runs_root: runs_root ?? DEFAULT_RUNS_ROOT };
}

function main(argv: string[] = process.argv): number {
  let opts: { write: boolean; runs_root: string };
  try {
    opts = parse_args(argv);
  } catch {
    return 2;
  }
  if (!fs.existsSync(opts.runs_root) || !fs.statSync(opts.runs_root).isDirectory()) {
    process.stderr.write(`runs-root is not a directory: ${opts.runs_root}\n`);
    return 2;
  }

  if (opts.write) {
    const result = write_live_runs(opts.runs_root, process.env);
    for (const run of result.rewritten) {
      process.stdout.write(`REWROTE ${run}\n`);
    }
    for (const run of result.unchanged) {
      process.stdout.write(`UNCHANGED ${run}\n`);
    }
    for (const s of result.skipped) {
      process.stdout.write(`SKIPPED ${s.run}: ${s.problems.join("; ")}\n`);
    }
    return result.skipped.length > 0 ? 1 : 0;
  }

  const results = check_live_runs(opts.runs_root);
  let ok = 0;
  for (const r of results) {
    if (r.problems.length === 0) {
      process.stdout.write(`OK ${r.run}\n`);
      ok++;
    } else {
      process.stdout.write(`PROBLEM ${r.run}: ${r.problems.join("; ")}\n`);
    }
  }
  process.stdout.write(`${ok}/${results.length} live runs match their peer events\n`);
  return ok === results.length ? 0 : 1;
}

process.exitCode = main(process.argv);
