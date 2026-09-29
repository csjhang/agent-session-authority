#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import { load_history_file } from "./history.js";
import { load_profile } from "./declaration.js";
import { default_assessment, load_assessment } from "./assessment.js";
import { run_checkers } from "./index.js";
import { build_report, format_report } from "./report.js";

export interface CliIo {
  cwd: string;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

function resolve_cwd(cwd: string, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(cwd, p);
}

function usage_text(): string {
  return "Usage: asa check <history.jsonl> [--assessment path] [--profile path] [--json]";
}

/**
 * Testable CLI entry. Returns process exit code:
 * 0 = no finding.result is violation
 * 1 = at least one finding.result is violation (post-rewrite)
 * 2 = tool error
 */
export function run_cli(argv: string[], io: CliIo): number {
  try {
    const args = argv.slice(2).filter((a) => a !== "--");
    if (args.length === 0) {
      io.stderr(usage_text() + "\n");
      return 2;
    }
    const cmd = args[0];
    if (cmd !== "check") {
      io.stderr(`Unknown command: ${cmd}\n${usage_text()}\n`);
      return 2;
    }
    const positional: string[] = [];
    let assessment_path: string | undefined;
    let profile_path: string | undefined;
    let json_out = false;
    for (let i = 1; i < args.length; i++) {
      const a = args[i]!;
      if (a === "--assessment") {
        const v = args[++i];
        if (v === undefined || v.startsWith("-")) {
          io.stderr(`--assessment requires a path value\n`);
          return 2;
        }
        assessment_path = v;
        continue;
      }
      if (a === "--profile") {
        const v = args[++i];
        if (v === undefined || v.startsWith("-")) {
          io.stderr(`--profile requires a path value\n`);
          return 2;
        }
        profile_path = v;
        continue;
      }
      if (a === "--json") {
        json_out = true;
        continue;
      }
      if (a.startsWith("-")) {
        io.stderr(`Unknown flag: ${a}\n${usage_text()}\n`);
        return 2;
      }
      positional.push(a);
    }
    const history_path_arg = positional[0];
    if (!history_path_arg) {
      io.stderr(usage_text() + "\n");
      return 2;
    }

    const history_path = resolve_cwd(io.cwd, history_path_arg);
    if (!fs.existsSync(history_path)) {
      io.stderr(`history file not found: ${history_path}\n`);
      return 2;
    }

    let events;
    try {
      events = load_history_file(history_path);
    } catch (err) {
      io.stderr(`history parse failed for ${history_path}: ${String(err)}\n`);
      return 2;
    }

    const resolved_profile =
      profile_path !== undefined ? resolve_cwd(io.cwd, profile_path) : undefined;
    const resolved_assessment =
      assessment_path !== undefined ? resolve_cwd(io.cwd, assessment_path) : undefined;

    let profile;
    try {
      profile = load_profile(resolved_profile);
    } catch (err) {
      io.stderr(`${String(err)}\n`);
      return 2;
    }

    let assessment;
    try {
      assessment = load_assessment(resolved_assessment) ?? default_assessment();
    } catch (err) {
      io.stderr(`${String(err)}\n`);
      return 2;
    }
    if (!assessment.test_basis) assessment.test_basis = "synthetic_fixture";

    const findings = run_checkers(events, profile, assessment);
    const report = build_report(findings, assessment, profile);
    if (json_out) {
      io.stdout(JSON.stringify(report, null, 2) + "\n");
    } else {
      io.stdout(format_report(report) + "\n");
    }

    const has_violation = findings.some((f) => f.result === "violation");
    return has_violation ? 1 : 0;
  } catch (err) {
    io.stderr(`unexpected error: ${String(err)}\n`);
    return 2;
  }
}
