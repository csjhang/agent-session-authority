/**
 * Shared live-runs directory walk: <runs_root>/<scenario>/<run_id>/.
 *
 * Used by live_reconvert (check/write) and scripts/live-vector (capability vector) so both
 * see the same run set. Policy (PR-10c): only REAL directories are walked at the scenario
 * and run layers (lstat semantics via Dirent; symlinks are never followed). Every other
 * entry at those layers — symlink (to a directory or not), plain file, anything else — is
 * returned as `rejected` with an explicit reason, never silently skipped, so callers can
 * surface it (live-vector → excluded with reason; reconvert → PROBLEM / exit 1).
 * A missing runs_root yields no entries; runs_root itself may be a symlink.
 */
import fs from "node:fs";
import path from "node:path";

export type LiveRunDirEntry =
  | { kind: "run"; scenario: string; run_id: string; run: string; dir: string }
  | {
      kind: "rejected";
      layer: "scenario" | "run";
      scenario: string;
      run_id?: string;
      /** "<scenario>" or "<scenario>/<run_id>" */
      run: string;
      path: string;
      reason: string;
    };

function describe_non_dir(d: fs.Dirent, abs: string): string {
  if (d.isSymbolicLink()) {
    try {
      const st = fs.statSync(abs);
      return st.isDirectory() ? "symlink to directory" : "symlink to non-directory";
    } catch {
      return "dangling symlink";
    }
  }
  if (d.isFile()) return "plain file";
  return "other filesystem entry";
}

function non_dir_reason(layer: "scenario" | "run", what: string): string {
  return `${layer} entry is not a real directory (${what}); symlinks and files at the scenario/run layers are not followed`;
}

function sorted_entries(dir: string): fs.Dirent[] {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Walk runs_root in sorted order (scenario, then run_id). */
export function list_live_run_dirs(runs_root: string): LiveRunDirEntry[] {
  const out: LiveRunDirEntry[] = [];
  if (!fs.existsSync(runs_root)) return out;
  for (const s of sorted_entries(runs_root)) {
    const sdir = path.join(runs_root, s.name);
    if (!s.isDirectory()) {
      out.push({
        kind: "rejected",
        layer: "scenario",
        scenario: s.name,
        run: s.name,
        path: sdir,
        reason: non_dir_reason("scenario", describe_non_dir(s, sdir)),
      });
      continue;
    }
    for (const r of sorted_entries(sdir)) {
      const dir = path.join(sdir, r.name);
      const run = `${s.name}/${r.name}`;
      if (!r.isDirectory()) {
        out.push({
          kind: "rejected",
          layer: "run",
          scenario: s.name,
          run_id: r.name,
          run,
          path: dir,
          reason: non_dir_reason("run", describe_non_dir(r, dir)),
        });
        continue;
      }
      out.push({ kind: "run", scenario: s.name, run_id: r.name, run, dir });
    }
  }
  return out;
}
