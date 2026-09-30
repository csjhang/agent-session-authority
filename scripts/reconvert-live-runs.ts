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

const DEFAULT_RUNS_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "targets",
  "claude-agent-acp",
  "results",
  "live-runs",
);

function usage_err(msg: string): never {
  process.stderr.write(msg + "\n");
  process.exitCode = 2;
  // Throw so callers under test can catch; top-level sets exitCode already.
  throw new Error(msg);
}

export function parse_args(argv: string[]): { write: boolean; runs_root: string } {
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
      runs_root = next!;
      i++;
      continue;
    }
    usage_err(`unknown argument: ${a}`);
  }
  return { write, runs_root: runs_root ?? DEFAULT_RUNS_ROOT };
}

export function main(argv: string[] = process.argv): number {
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
    const results = write_live_runs(opts.runs_root, process.env);
    let n_ok = 0;
    for (const r of results) {
      if (r.status === "SKIPPED") {
        process.stdout.write(`SKIPPED ${r.key}: ${r.problem}\n`);
      } else {
        process.stdout.write(`${r.status} ${r.key}\n`);
        n_ok++;
      }
    }
    process.stdout.write(`${n_ok}/${results.length} ok\n`);
    return results.some((r) => r.status === "SKIPPED") ? 1 : 0;
  }

  const results = check_live_runs(opts.runs_root);
  let n_ok = 0;
  for (const r of results) {
    if (r.ok) {
      process.stdout.write(`OK ${r.key}\n`);
      n_ok++;
    } else {
      process.stdout.write(`PROBLEM ${r.key}: ${r.problem}\n`);
    }
  }
  process.stdout.write(`${n_ok}/${results.length} ok\n`);
  return n_ok === results.length ? 0 : 1;
}

const is_direct =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (is_direct) {
  process.exitCode = main(process.argv);
}
