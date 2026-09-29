#!/usr/bin/env node
import { run_cli } from "./cli_run.js";

// exitCode (not process.exit) so buffered stdout/stderr drain fully when piped.
process.exitCode = run_cli(process.argv, {
  cwd: process.cwd(),
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
});
