#!/usr/bin/env node
import { run_cli } from "./cli_run.js";

process.exit(
  run_cli(process.argv, {
    cwd: process.cwd(),
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  }),
);
