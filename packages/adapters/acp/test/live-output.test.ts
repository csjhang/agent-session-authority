/**
 * Offline tests for src/live_output.ts (write_live_run / secret_leak_reason).
 * On the first commit this file fails to load because live_output.ts is absent.
 * Never calls real claude-agent-acp or the Anthropic API.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collect_history } from "../src/index.js";
import { write_live_run } from "../src/live_output.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fake_agent = path.join(here, "fixtures", "fake-acp-agent.mjs");

function tmp_dir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `asa-pr6f-out-${label}-`));
}

describe("live_output write_live_run", () => {
  it(
    "write_live_run: distinct run ids create dirs with history.jsonl and run.json; duplicate and bad run id throw",
    async () => {
      const cwd = tmp_dir("cwd");
      const out_root = tmp_dir("out");
      const result = await collect_history({
        mode: "live",
        scenario: "effect",
        cwd,
        live_command: process.execPath,
        live_args: [fake_agent],
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: "offline-fake-agent-placeholder",
        },
        effect_grace_ms: 3000,
        always_grant_poll_ms: 3000,
        live_observe_ms: 5000,
      });

      const r1 = write_live_run(result, {
        out_root,
        scenario: "effect",
        run_id: "run1",
        env: process.env,
      });
      const r2 = write_live_run(result, {
        out_root,
        scenario: "effect",
        run_id: "run2",
        env: process.env,
      });
      expect(r1).not.toBe(r2);
      for (const dir of [r1, r2]) {
        expect(fs.existsSync(path.join(dir, "history.jsonl"))).toBe(true);
        const run = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8"));
        expect(run.scenario).toBe("effect");
        expect(run.package_version_pinned).toBe("0.75.1");
        expect(run.package_version_observed).toBe("0.75.1");
        expect(run.run_valid).toBe(true);
      }
      expect(() =>
        write_live_run(result, {
          out_root,
          scenario: "effect",
          run_id: "run1",
          env: process.env,
        }),
      ).toThrow(/already exists/);
      expect(() =>
        write_live_run(result, {
          out_root,
          scenario: "effect",
          run_id: "../escape",
          env: process.env,
        }),
      ).toThrow(/run id/);
    },
    30000,
  );

  it(
    "write_live_run: ASA_FAKE_ECHO_KEY result containing API key placeholder is refused and writes nothing",
    async () => {
      const cwd = tmp_dir("echo-cwd");
      const out_root = tmp_dir("echo-out");
      const key = "offline-fake-agent-placeholder";
      const result = await collect_history({
        mode: "live",
        scenario: "effect",
        cwd,
        live_command: process.execPath,
        live_args: [fake_agent],
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: key,
          ASA_FAKE_ECHO_KEY: "1",
        },
        effect_grace_ms: 3000,
        always_grant_poll_ms: 3000,
        live_observe_ms: 5000,
      });
      expect(result.history_jsonl).toContain(key);
      expect(() =>
        write_live_run(result, {
          out_root,
          scenario: "effect",
          run_id: "leak1",
          env: { ...process.env, ANTHROPIC_API_KEY: key },
        }),
      ).toThrow(/ANTHROPIC_API_KEY/);
      expect(fs.readdirSync(out_root)).toHaveLength(0);
    },
    30000,
  );

  it(
    "write_live_run: run.json events/history_events are counts; peer-events.jsonl has one JSON line per peer event",
    async () => {
      const cwd = tmp_dir("counts-cwd");
      const out_root = tmp_dir("counts-out");
      const result = await collect_history({
        mode: "live",
        scenario: "effect",
        cwd,
        live_command: process.execPath,
        live_args: [fake_agent],
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: "offline-fake-agent-placeholder",
        },
        effect_grace_ms: 3000,
        always_grant_poll_ms: 3000,
        live_observe_ms: 5000,
      });
      const run_dir = write_live_run(result, {
        out_root,
        scenario: "effect",
        run_id: "counts1",
        env: process.env,
      });
      const run = JSON.parse(fs.readFileSync(path.join(run_dir, "run.json"), "utf8"));
      expect(typeof run.events).toBe("number");
      expect(typeof run.history_events).toBe("number");
      expect(run.events).toBe(result.events.length);
      expect(run.history_events).toBe(result.history.length);
      const peer_path = path.join(run_dir, "peer-events.jsonl");
      expect(fs.existsSync(peer_path)).toBe(true);
      const peer_lines = fs.readFileSync(peer_path, "utf8").split(/\r?\n/).filter((l) => l.trim());
      expect(peer_lines.length).toBe(result.events.length);
      for (const line of peer_lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    },
    30000,
  );

  it(
    "write_live_run: secret only in result.events (history_jsonl clean) is refused and writes nothing",
    async () => {
      const cwd = tmp_dir("evt-leak-cwd");
      const out_root = tmp_dir("evt-leak-out");
      const key = "offline-fake-agent-placeholder";
      const result = await collect_history({
        mode: "live",
        scenario: "effect",
        cwd,
        live_command: process.execPath,
        live_args: [fake_agent],
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: key,
        },
        effect_grace_ms: 3000,
        always_grant_poll_ms: 3000,
        live_observe_ms: 5000,
      });
      expect(result.history_jsonl).not.toContain(key);
      result.events.push({
        type: "session_update",
        sessionId: "leak-session",
        update: { kind: "agent_message_chunk", text: `key=${key}` },
      });
      expect(() =>
        write_live_run(result, {
          out_root,
          scenario: "effect",
          run_id: "evt-leak1",
          env: { ...process.env, ANTHROPIC_API_KEY: key },
        }),
      ).toThrow(/ANTHROPIC_API_KEY/);
      expect(fs.readdirSync(out_root)).toHaveLength(0);
    },
    30000,
  );
});
