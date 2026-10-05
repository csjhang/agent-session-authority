import fs from "node:fs";
import path from "node:path";
import type { AcpPeerEvent } from "./mock_peer.js";
import { live_history_from_peer_events, history_to_jsonl } from "./history_from_acp.js";
import { secret_leak_reason } from "./live_output.js";
import { list_live_run_dirs } from "./live_run_dirs.js";

export type LiveReconvertCheck = {
  run: string; // "<scenario>/<run_id>"
  dir: string;
  problems: string[];
  reconverted?: string;
};

function jsonl_nonempty_line_count(text: string): number {
  let n = 0;
  for (const line of text.split("\n")) {
    if (line.trim()) n++;
  }
  return n;
}

function first_differing_line(a: string, b: string): number | undefined {
  const al = a.split("\n");
  const bl = b.split("\n");
  const n = Math.max(al.length, bl.length);
  for (let i = 0; i < n; i++) {
    if (al[i] !== bl[i]) return i + 1;
  }
  return undefined;
}

function load_peer_events(peer_path: string):
  | { events: AcpPeerEvent[]; peer_lines: number }
  | { error: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(peer_path, "utf8");
  } catch (err) {
    return { error: "peer-events.jsonl unreadable: " + (err instanceof Error ? err.message : String(err)) };
  }
  const events: AcpPeerEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as AcpPeerEvent);
    } catch (err) {
      return {
        error: "peer-events.jsonl unreadable: " + (err instanceof Error ? err.message : String(err)),
      };
    }
  }
  return { events, peer_lines: events.length };
}

/**
 * Check one live-run directory: peer-events → live_history_from_peer_events must
 * byte-match history.jsonl (no newline normalization); run.json counts must match.
 */
export function check_live_run(dir: string, run: string): LiveReconvertCheck {
  const problems: string[] = [];
  const peer_path = path.join(dir, "peer-events.jsonl");
  const hist_path = path.join(dir, "history.jsonl");
  const run_path = path.join(dir, "run.json");

  let reconverted: string | undefined;
  let peer_lines: number | undefined;

  if (!fs.existsSync(peer_path)) {
    problems.push("peer-events.jsonl missing");
  } else {
    const loaded = load_peer_events(peer_path);
    if ("error" in loaded) {
      problems.push(loaded.error);
    } else {
      peer_lines = loaded.peer_lines;
      reconverted = history_to_jsonl(live_history_from_peer_events(loaded.events));
    }
  }

  let hist_raw: string | undefined;
  if (!fs.existsSync(hist_path)) {
    problems.push("history.jsonl missing");
  } else {
    try {
      hist_raw = fs.readFileSync(hist_path, "utf8");
    } catch {
      problems.push("history.jsonl missing");
    }
  }

  let run_obj: { events?: unknown; history_events?: unknown } | undefined;
  if (!fs.existsSync(run_path)) {
    problems.push("run.json missing or unreadable");
  } else {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(run_path, "utf8"));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        problems.push("run.json missing or unreadable");
      } else {
        run_obj = parsed as { events?: unknown; history_events?: unknown };
      }
    } catch {
      problems.push("run.json missing or unreadable");
    }
  }

  if (run_obj !== undefined && peer_lines !== undefined) {
    const n = run_obj.events;
    if (n !== peer_lines) {
      problems.push(`run.json events=${JSON.stringify(n)} != peer-events.jsonl lines ${peer_lines}`);
    }
  }

  if (reconverted !== undefined && hist_raw !== undefined) {
    if (hist_raw !== reconverted) {
      const k = first_differing_line(hist_raw, reconverted) ?? 1;
      problems.push(
        `history.jsonl differs from reconversion of peer-events.jsonl (first differing line ${k})`,
      );
    }
  }

  if (run_obj !== undefined && hist_raw !== undefined) {
    const m = jsonl_nonempty_line_count(hist_raw);
    const n = run_obj.history_events;
    if (n !== m) {
      problems.push(`run.json history_events=${JSON.stringify(n)} != history.jsonl lines ${m}`);
    }
  }

  const out: LiveReconvertCheck = { run, dir, problems };
  if (reconverted !== undefined) out.reconverted = reconverted;
  return out;
}

/**
 * Check every `<scenario>/<run_id>` under runs_root (sorted by run name).
 * Symlinks / plain files at the scenario or run layer are reported as a problem
 * (never followed, never silently skipped) — see list_live_run_dirs.
 */
export function check_live_runs(runs_root: string): LiveReconvertCheck[] {
  return list_live_run_dirs(runs_root).map((e) =>
    e.kind === "run" ? check_live_run(e.dir, e.run) : { run: e.run, dir: e.path, problems: [e.reason] },
  );
}

/**
 * Rewrite history.jsonl (and run.json history_events) from peer-events when they
 * diverge. Never modifies peer-events.jsonl. Throws if secret_leak_reason hits.
 */
export function write_live_runs(
  runs_root: string,
  env: NodeJS.ProcessEnv,
): {
  rewritten: string[];
  unchanged: string[];
  skipped: { run: string; problems: string[] }[];
} {
  const rewritten: string[] = [];
  const unchanged: string[] = [];
  const skipped: { run: string; problems: string[] }[] = [];

  for (const entry of list_live_run_dirs(runs_root)) {
    if (entry.kind === "rejected") {
      // Never write through a symlink / into a non-directory.
      skipped.push({ run: entry.run, problems: [entry.reason] });
      continue;
    }
    const { run, dir } = entry;
    const check = check_live_run(dir, run);
    const { problems } = check;

    const skip_reasons = problems.filter(
      (p) =>
        p === "peer-events.jsonl missing" ||
        p === "history.jsonl missing" ||
        p === "run.json missing or unreadable" ||
        p.startsWith("peer-events.jsonl unreadable: ") ||
        p.startsWith("run.json events="),
    );

    if (skip_reasons.length > 0) {
      skipped.push({ run, problems });
      continue;
    }

    if (problems.length === 0) {
      unchanged.push(run);
      continue;
    }

    // Only history content differs and/or history_events mismatch → rewrite.
    const reconverted = check.reconverted;
    if (reconverted === undefined) {
      skipped.push({ run, problems });
      continue;
    }

    const hist_path = path.join(dir, "history.jsonl");
    const run_path = path.join(dir, "run.json");
    const run_obj = JSON.parse(fs.readFileSync(run_path, "utf8")) as Record<string, unknown>;
    const history_events = jsonl_nonempty_line_count(reconverted);
    run_obj.history_events = history_events;
    const run_body = JSON.stringify(run_obj, null, 2) + "\n";

    const hist_leak = secret_leak_reason(reconverted, env);
    if (hist_leak) {
      throw new Error(`refusing to write history.jsonl: ${hist_leak}`);
    }
    const run_leak = secret_leak_reason(run_body, env);
    if (run_leak) {
      throw new Error(`refusing to write run.json: ${run_leak}`);
    }

    fs.writeFileSync(hist_path, reconverted);
    fs.writeFileSync(run_path, run_body);
    rewritten.push(run);
  }

  return { rewritten, unchanged, skipped };
}
