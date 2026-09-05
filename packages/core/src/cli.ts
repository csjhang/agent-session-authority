#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import { load_history_file } from "./history.js";
import { load_profile } from "./declaration.js";
import { default_assessment, load_assessment } from "./assessment.js";
import { run_checkers } from "./index.js";
import { build_report, format_report } from "./report.js";

function usage(): never {
  console.error("Usage: asa check <history.jsonl> [--assessment path] [--profile path]");
  process.exit(2);
}

function resolve_existing(p: string): string {
  const candidates = [
    path.resolve(p),
    path.resolve(process.cwd(), p),
    path.resolve(process.cwd(), "../..", p),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return path.resolve(p);
}

function main(argv: string[]): void {
  const args = argv.slice(2).filter((a) => a !== "--");
  if (args.length === 0) usage();
  const cmd = args[0];
  if (cmd !== "check") usage();
  const positional: string[] = [];
  let assessment_path: string | undefined;
  let profile_path: string | undefined;
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--assessment") { assessment_path = args[++i]; continue; }
    if (a === "--profile") { profile_path = args[++i]; continue; }
    if (a.startsWith("-")) {
      console.error(`Unknown flag: ${a}`);
      usage();
    }
    positional.push(a);
  }
  const history_path = positional[0];
  if (!history_path) usage();

  const events = load_history_file(resolve_existing(history_path));
  const profile = load_profile(profile_path ? resolve_existing(profile_path) : undefined);
  const assessment = load_assessment(assessment_path ? resolve_existing(assessment_path) : undefined) ?? default_assessment();
  if (!assessment.test_basis) assessment.test_basis = "synthetic_fixture";

  const findings = run_checkers(events, profile, assessment);
  const report = build_report(findings, assessment, profile);
  console.log(format_report(report));
  console.log("");
  console.log(JSON.stringify(report, null, 2));

  const has_violation = findings.some((f) => f.result === "violation");
  process.exit(has_violation ? 1 : 0);
}

main(process.argv);
