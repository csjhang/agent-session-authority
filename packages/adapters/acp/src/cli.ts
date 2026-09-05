#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collect_history, type AdapterMode } from "./index.js";

const args = process.argv.slice(2);
let mode: AdapterMode = "fixture";
const mode_idx = args.indexOf("--mode");
if (mode_idx >= 0 && args[mode_idx + 1]) {
  mode = args[mode_idx + 1] === "live" ? "live" : "fixture";
}

const result = await collect_history({ mode });
const here = path.dirname(fileURLToPath(import.meta.url));
const repo_root = path.resolve(here, "../../../..");
const out_dir = path.join(repo_root, "targets/claude-agent-acp/results");
fs.mkdirSync(out_dir, { recursive: true });
const hist_path = path.join(out_dir, `history-${result.mode}.jsonl`);
fs.writeFileSync(hist_path, result.history_jsonl);
console.log(JSON.stringify({ mode: result.mode, history_path: hist_path, notes: result.notes, events: result.events.length }, null, 2));
