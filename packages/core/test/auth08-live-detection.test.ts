import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { load_history_file } from "../src/history.js";
import {
  examine_committed_receipts,
  count_asked,
  count_never_asked,
  count_unmappable,
} from "../src/checker/auth08.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo_root = path.resolve(here, "../../..");
const LIVE = path.join(
  repo_root,
  "targets/claude-agent-acp/results/live-runs",
);

function list_histories(opts: { auth08_only?: boolean; exclude_auth08?: boolean }): string[] {
  const histories: string[] = [];
  for (const scenario of fs.readdirSync(LIVE).sort()) {
    const sp = path.join(LIVE, scenario);
    if (!fs.statSync(sp).isDirectory()) continue;
    const is_auth08 = scenario.startsWith("auth08-");
    if (opts.exclude_auth08 && is_auth08) continue;
    if (opts.auth08_only && !is_auth08) continue;
    for (const run of fs.readdirSync(sp).sort()) {
      const hp = path.join(sp, run, "history.jsonl");
      if (fs.existsSync(hp)) histories.push(hp);
    }
  }
  return histories;
}

describe("AUTH-08 live never-asked detection (override J)", () => {
  it("non-auth08: 16 histories, 22 committed receipts: all asked via tool_call_id; never-asked=0; unmappable=0", () => {
    const histories = list_histories({ exclude_auth08: true });
    expect(histories.length).toBe(16);

    const all = [];
    for (const hp of histories) {
      const events = load_history_file(hp, { warn_unknown_vocab: false });
      all.push(...examine_committed_receipts(events));
    }

    expect(all.length).toBe(22);
    expect(all.every((e) => !!e.tool_call_id)).toBe(true);
    expect(count_asked(all)).toBe(22);
    expect(count_never_asked(all)).toBe(0);
    expect(count_unmappable(all)).toBe(0);
    expect(all.every((e) => e.classification === "asked")).toBe(true);
  });

  it("auth08-* per run-id: examine_committed_receipts classification + bypass_path_id (Phase A r1)", () => {
    // Per run-id rows (not scenario-only aggregates). Phase B adds further
    // run-id rows from observed evidence; do not collapse to scenario labels.
    const expected: Array<{
      scenario: string;
      run_id: string;
      classification: string;
      bypass_path_id: string | null;
    }> = [
      {
        scenario: "auth08-p5-default-bash-write",
        run_id: "r1",
        classification: "asked",
        bypass_path_id: null,
      },
      {
        scenario: "auth08-p4-settings-allow",
        run_id: "r1",
        classification: "asked",
        bypass_path_id: null,
      },
      {
        scenario: "auth08-p4-settings-defaultMode",
        run_id: "r1",
        classification: "asked",
        bypass_path_id: null,
      },
      {
        scenario: "auth08-p2-acceptEdits-write",
        run_id: "r1",
        classification: "bypass",
        bypass_path_id: "mode:acceptEdits:Write",
      },
      {
        scenario: "auth08-p2-acceptEdits-bash-fs-command",
        run_id: "r1",
        classification: "bypass",
        bypass_path_id: "mode:acceptEdits:Bash:fs_command",
      },
      {
        scenario: "auth08-p2-acceptEdits-bash-redirect",
        run_id: "r1",
        classification: "bypass",
        bypass_path_id: "mode:acceptEdits:Bash:redirect",
      },
      {
        scenario: "auth08-p1-bypassPermissions-write",
        run_id: "r1",
        classification: "bypass",
        bypass_path_id: "mode:bypassPermissions:Bash:redirect",
      },
    ];

    type Row = (typeof expected)[number];
    const observed_by_key = new Map<string, Row[]>();
    for (const scenario of fs.readdirSync(LIVE)) {
      if (!scenario.startsWith("auth08-")) continue;
      const sp = path.join(LIVE, scenario);
      if (!fs.statSync(sp).isDirectory()) continue;
      for (const run_id of fs.readdirSync(sp)) {
        const hp = path.join(sp, run_id, "history.jsonl");
        if (!fs.existsSync(hp)) continue;
        const events = load_history_file(hp, { warn_unknown_vocab: false });
        const examined = examine_committed_receipts(events);
        expect(
          examined.length,
          `${scenario}/${run_id} committed receipts`,
        ).toBeGreaterThanOrEqual(1);
        const key = `${scenario}/${run_id}`;
        observed_by_key.set(
          key,
          examined.map((e) => ({
            scenario,
            run_id,
            classification: e.classification,
            bypass_path_id: e.bypass_path_id ?? null,
          })),
        );
      }
    }

    const expected_keys = new Set(expected.map((e) => `${e.scenario}/${e.run_id}`));
    expect([...observed_by_key.keys()].sort()).toEqual([...expected_keys].sort());

    for (const row of expected) {
      const key = `${row.scenario}/${row.run_id}`;
      const rows = observed_by_key.get(key);
      expect(rows, key).toBeDefined();
      expect(rows!.length, `${key} receipt count`).toBe(1);
      expect(rows![0]).toEqual(row);
    }
  });
});
