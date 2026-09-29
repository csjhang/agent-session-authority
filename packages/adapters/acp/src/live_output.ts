import fs from "node:fs";
import path from "node:path";

export const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Minimal run payload accepted by write_live_run (matches AcpAdapterResult live fields). */
export interface LiveRunWritable {
  mode: string;
  package_name: string;
  package_version_pinned: string;
  package_version_observed?: string;
  run_valid: boolean;
  invalid_reasons: string[];
  events: unknown[];
  history: unknown[];
  history_jsonl: string;
  notes: string[];
}

export function secret_leak_reason(
  text: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const key = env.ANTHROPIC_API_KEY;
  if (typeof key === "string" && key.length >= 8 && text.includes(key)) {
    return "output contains the ANTHROPIC_API_KEY value";
  }
  if (/sk-ant-[A-Za-z0-9_-]{10,}/.test(text)) {
    return "output contains an sk-ant- key pattern";
  }
  return undefined;
}

export function write_live_run(
  result: LiveRunWritable,
  opts: {
    out_root: string;
    scenario: string;
    run_id: string;
    env: NodeJS.ProcessEnv;
  },
): string {
  const { out_root, scenario, run_id, env } = opts;
  if (!RUN_ID_PATTERN.test(run_id)) {
    throw new Error(`invalid run id ${JSON.stringify(run_id)}: must match ${RUN_ID_PATTERN}`);
  }
  const run_dir = path.join(out_root, scenario, run_id);
  if (fs.existsSync(run_dir)) {
    throw new Error(`live run directory already exists: ${run_dir}`);
  }

  const history_jsonl = result.history_jsonl;
  const run_json = {
    mode: result.mode,
    scenario,
    run_id,
    package_name: result.package_name,
    package_version_pinned: result.package_version_pinned,
    package_version_observed: result.package_version_observed ?? null,
    run_valid: result.run_valid,
    invalid_reasons: result.invalid_reasons,
    events: result.events,
    history_events: result.history,
    notes: result.notes,
  };
  const run_body = JSON.stringify(run_json, null, 2);

  const leak_h = secret_leak_reason(history_jsonl, env);
  if (leak_h) {
    throw new Error(`refusing to write live run: ${leak_h}`);
  }
  const leak_r = secret_leak_reason(run_body, env);
  if (leak_r) {
    throw new Error(`refusing to write live run: ${leak_r}`);
  }

  fs.mkdirSync(run_dir, { recursive: true });
  fs.writeFileSync(path.join(run_dir, "history.jsonl"), history_jsonl);
  fs.writeFileSync(path.join(run_dir, "run.json"), run_body);
  return run_dir;
}
