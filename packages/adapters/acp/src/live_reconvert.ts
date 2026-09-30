import fs from "node:fs";
import path from "node:path";
import type { AcpPeerEvent } from "./mock_peer.js";
import { live_history_from_peer_events, history_to_jsonl } from "./history_from_acp.js";
import { secret_leak_reason } from "./live_output.js";

/** Relative run key under runs_root: `<scenario>/<run_id>`. */
export type LiveRunKey = string;

export type LiveRunCheck =
  | { key: LiveRunKey; ok: true }
  | { key: LiveRunKey; ok: false; problem: string };

export type LiveRunWrite =
  | { key: LiveRunKey; status: "REWROTE" }
  | { key: LiveRunKey; status: "UNCHANGED" }
  | { key: LiveRunKey; status: "SKIPPED"; problem: string };

function sorted_run_dirs(runs_root: string): Array<{ key: LiveRunKey; run_dir: string }> {
  const out: Array<{ key: LiveRunKey; run_dir: string }> = [];
  if (!fs.existsSync(runs_root)) return out;
  for (const scenario of fs.readdirSync(runs_root).sort()) {
    const sdir = path.join(runs_root, scenario);
    if (!fs.statSync(sdir).isDirectory()) continue;
    for (const run_id of fs.readdirSync(sdir).sort()) {
      const run_dir = path.join(sdir, run_id);
      if (!fs.statSync(run_dir).isDirectory()) continue;
      out.push({ key: `${scenario}/${run_id}`, run_dir });
    }
  }
  return out;
}

function load_peer_events(peer_path: string): AcpPeerEvent[] | { problem: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(peer_path, "utf8");
  } catch (err) {
    return { problem: `peer-events.jsonl unreadable: ${String(err instanceof Error ? err.message : err)}` };
  }
  const events: AcpPeerEvent[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as AcpPeerEvent);
    } catch (err) {
      return {
        problem: `peer-events.jsonl line ${i + 1} unreadable: ${String(err instanceof Error ? err.message : err)}`,
      };
    }
  }
  return events;
}

function reconvert_history_jsonl(run_dir: string): { history_jsonl: string } | { problem: string } {
  const peer_path = path.join(run_dir, "peer-events.jsonl");
  if (!fs.existsSync(peer_path)) {
    return { problem: "missing peer-events.jsonl" };
  }
  const loaded = load_peer_events(peer_path);
  if ("problem" in loaded) return loaded;
  const history = live_history_from_peer_events(loaded);
  return { history_jsonl: history_to_jsonl(history) };
}

/**
 * Check one live-run directory: peer-events → live_history_from_peer_events must
 * byte-match history.jsonl (no newline normalization).
 */
export function check_live_run(run_dir: string, key?: LiveRunKey): LiveRunCheck {
  const k = key ?? path.basename(path.dirname(run_dir)) + "/" + path.basename(run_dir);
  const hist_path = path.join(run_dir, "history.jsonl");
  const recon = reconvert_history_jsonl(run_dir);
  if ("problem" in recon) {
    return { key: k, ok: false, problem: recon.problem };
  }
  if (!fs.existsSync(hist_path)) {
    return { key: k, ok: false, problem: "missing history.jsonl" };
  }
  let hist_raw: string;
  try {
    hist_raw = fs.readFileSync(hist_path, "utf8");
  } catch (err) {
    return {
      key: k,
      ok: false,
      problem: `history.jsonl unreadable: ${String(err instanceof Error ? err.message : err)}`,
    };
  }
  // Byte compare — no newline normalize.
  if (hist_raw !== recon.history_jsonl) {
    return { key: k, ok: false, problem: "history.jsonl does not match reconversion from peer-events.jsonl" };
  }
  return { key: k, ok: true };
}

/** Check every `<scenario>/<run_id>` under runs_root (sorted). */
export function check_live_runs(runs_root: string): LiveRunCheck[] {
  return sorted_run_dirs(runs_root).map(({ key, run_dir }) => check_live_run(run_dir, key));
}

/**
 * Rewrite history.jsonl from peer-events when it differs. Never modifies peer-events.
 * Runs secret_leak_reason on the new history before write; leak → SKIPPED.
 */
export function write_live_runs(
  runs_root: string,
  env: NodeJS.ProcessEnv = process.env,
): LiveRunWrite[] {
  const results: LiveRunWrite[] = [];
  for (const { key, run_dir } of sorted_run_dirs(runs_root)) {
    const recon = reconvert_history_jsonl(run_dir);
    if ("problem" in recon) {
      results.push({ key, status: "SKIPPED", problem: recon.problem });
      continue;
    }
    const hist_path = path.join(run_dir, "history.jsonl");
    let hist_raw: string | undefined;
    if (fs.existsSync(hist_path)) {
      try {
        hist_raw = fs.readFileSync(hist_path, "utf8");
      } catch (err) {
        results.push({
          key,
          status: "SKIPPED",
          problem: `history.jsonl unreadable: ${String(err instanceof Error ? err.message : err)}`,
        });
        continue;
      }
    }
    if (hist_raw === recon.history_jsonl) {
      results.push({ key, status: "UNCHANGED" });
      continue;
    }
    const leak = secret_leak_reason(recon.history_jsonl, env);
    if (leak) {
      results.push({ key, status: "SKIPPED", problem: `refusing to write history.jsonl: ${leak}` });
      continue;
    }
    fs.writeFileSync(hist_path, recon.history_jsonl);
    results.push({ key, status: "REWROTE" });
  }
  return results;
}
