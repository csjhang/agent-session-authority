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

describe("AUTH-08 live never-asked detection (override J)", () => {
  it("22 committed receipts: all asked via tool_call_id; never-asked=0; unmappable=0", () => {
    const histories: string[] = [];
    for (const scenario of fs.readdirSync(LIVE)) {
      const sp = path.join(LIVE, scenario);
      if (!fs.statSync(sp).isDirectory()) continue;
      for (const run of fs.readdirSync(sp)) {
        const hp = path.join(sp, run, "history.jsonl");
        if (fs.existsSync(hp)) histories.push(hp);
      }
    }
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
});
