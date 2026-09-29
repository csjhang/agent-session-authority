#!/usr/bin/env tsx
/**
 * Generate corpus/acp-shaped/*.jsonl via acp_events_to_history.
 * Paths are always absolute; session_cwd is fixed to /ws.
 *
 * Export `generate_acp_shaped_corpus()` for in-process tests (map filename → JSONL).
 * CLI mode writes files under corpus/acp-shaped/.
 *
 * Regeneration: pnpm exec tsx scripts/generate-acp-shaped-corpus.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { acp_events_to_history, history_to_jsonl } from "../packages/adapters/acp/src/history_from_acp.js";
import type { AcpPeerEvent } from "../packages/adapters/acp/src/mock_peer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const out_dir = path.resolve(here, "../corpus/acp-shaped");

const SID = "acp-shaped-session";
const CWD = "/ws";
const OPTIONS = [
  { optionId: "allow-once", kind: "allow_once" },
  { optionId: "reject", kind: "reject_once" },
];

/** Fixed base so regenerations are byte-stable aside from any non-obs fields. */
const BASE_MS = 1_700_000_000_000;

function abs(rel: string): string {
  return path.posix.join(CWD, rel);
}

function stamp(events: AcpPeerEvent[]): AcpPeerEvent[] {
  return events.map((e, i) => ({ ...e, observed_at_ms: BASE_MS + i * 1000 }));
}

const scenarios: Record<string, AcpPeerEvent[]> = {
  "a1-reask-after-restart.jsonl": [
    {
      type: "permission_request",
      sessionId: SID,
      requestId: "r1",
      toolName: "Write",
      toolCallId: "tc1",
      input: { file_path: abs("a1-g1.txt"), content: "g1" },
      options: OPTIONS,
    },
    {
      type: "permission_response",
      sessionId: SID,
      requestId: "r1",
      decision: "allow",
      optionId: "allow-once",
      optionKind: "allow_once",
    },
    {
      type: "session_update",
      sessionId: SID,
      update: {
        kind: "effect_receipt",
        sink: "fixture_fs",
        path: abs("a1-g1.txt"),
        present: true,
        matched: true,
        expected: "g1",
        content: "g1",
      },
    },
    { type: "runtime_restart", sessionId: SID, reason: "restart" },
    {
      type: "permission_request",
      sessionId: SID,
      requestId: "r2",
      toolName: "Write",
      toolCallId: "tc2",
      input: { file_path: abs("a1-g2.txt"), content: "g2" },
      options: OPTIONS,
    },
    {
      type: "permission_response",
      sessionId: SID,
      requestId: "r2",
      decision: "allow",
      optionId: "allow-once",
      optionKind: "allow_once",
    },
    {
      type: "session_update",
      sessionId: SID,
      update: {
        kind: "effect_receipt",
        sink: "fixture_fs",
        path: abs("a1-g2.txt"),
        present: true,
        matched: true,
        expected: "g2",
        content: "g2",
      },
    },
  ],

  "a2-stale-grant-no-reask.jsonl": [
    {
      type: "permission_request",
      sessionId: SID,
      requestId: "r1",
      toolName: "Write",
      toolCallId: "tc1",
      input: { file_path: abs("a2.txt"), content: "g1" },
      options: OPTIONS,
    },
    {
      type: "permission_response",
      sessionId: SID,
      requestId: "r1",
      decision: "allow",
      optionId: "allow-once",
      optionKind: "allow_once",
    },
    {
      type: "session_update",
      sessionId: SID,
      update: {
        kind: "effect_receipt",
        sink: "fixture_fs",
        path: abs("a2.txt"),
        present: true,
        matched: true,
        expected: "g1",
        content: "g1",
      },
    },
    { type: "runtime_restart", sessionId: SID, reason: "restart" },
    {
      type: "permission_response",
      sessionId: SID,
      requestId: "r1",
      decision: "allow",
      optionId: "allow-once",
      optionKind: "allow_once",
    },
    {
      type: "permission_request",
      sessionId: SID,
      requestId: "r2",
      toolName: "Write",
      toolCallId: "tc2",
      input: { file_path: abs("a2.txt"), content: "g2" },
      options: OPTIONS,
    },
    {
      type: "session_update",
      sessionId: SID,
      update: {
        kind: "effect_receipt",
        sink: "fixture_fs",
        path: abs("a2.txt"),
        present: true,
        matched: true,
        expected: "g2",
        content: "g2",
      },
    },
  ],

  "a3-deny-then-committed.jsonl": [
    {
      type: "permission_request",
      sessionId: SID,
      requestId: "r1",
      toolName: "Write",
      toolCallId: "tc1",
      input: { file_path: abs("a3.txt"), content: "x" },
      options: OPTIONS,
    },
    {
      type: "permission_response",
      sessionId: SID,
      requestId: "r1",
      decision: "deny",
      optionId: "reject",
      optionKind: "reject_once",
    },
    {
      type: "session_update",
      sessionId: SID,
      update: {
        kind: "effect_receipt",
        sink: "fixture_fs",
        path: abs("a3.txt"),
        present: true,
        matched: true,
        expected: "x",
        content: "x",
      },
    },
  ],

  "a4-no-request-committed.jsonl": [
    {
      type: "session_update",
      sessionId: SID,
      update: {
        kind: "effect_receipt",
        sink: "fixture_fs",
        path: abs("a4.txt"),
        present: true,
        matched: true,
        expected: "x",
        content: "x",
      },
    },
  ],

  "a5-unknown-only.jsonl": [
    {
      type: "permission_request",
      sessionId: SID,
      requestId: "r1",
      toolName: "Write",
      toolCallId: "tc1",
      input: { file_path: abs("a5.txt"), content: "x" },
      options: OPTIONS,
    },
    {
      type: "permission_response",
      sessionId: SID,
      requestId: "r1",
      decision: "allow",
      optionId: "allow-once",
      optionKind: "allow_once",
    },
    {
      type: "session_update",
      sessionId: SID,
      update: {
        kind: "effect_receipt",
        sink: "fixture_fs",
        path: abs("a5.txt"),
        present: false,
        absent: true,
        expected: "x",
      },
    },
  ],

  "a6-orphan-only.jsonl": [
    {
      type: "permission_request",
      sessionId: SID,
      requestId: "r1",
      toolName: "Write",
      toolCallId: "tc1",
      input: { file_path: abs("a6.txt"), content: "x" },
      options: OPTIONS,
    },
    {
      type: "permission_response",
      sessionId: SID,
      requestId: "r1",
      decision: "allow",
      optionId: "allow-once",
      optionKind: "allow_once",
    },
    { type: "runtime_restart", sessionId: SID, reason: "restart" },
    {
      type: "permission_response",
      sessionId: SID,
      requestId: "r1",
      decision: "allow",
      optionId: "allow-once",
      optionKind: "allow_once",
    },
    {
      type: "session_update",
      sessionId: SID,
      update: {
        kind: "effect_receipt",
        sink: "fixture_fs",
        path: abs("a6.txt"),
        present: true,
        matched: true,
        expected: "x",
        content: "x",
      },
    },
  ],

  /**
   * AUTH-02: deny → restart → re-ask same action (same path/content = same digest)
   * with new nonce/runtime_generation → grant → committed = supported.
   * Different nonce/runtime_generation must NOT be treated as rebound.
   */
  "a7-deny-restart-reask-same-action.jsonl": [
    {
      type: "permission_request",
      sessionId: SID,
      requestId: "r1",
      toolName: "Write",
      toolCallId: "tc1",
      input: { file_path: abs("a7.txt"), content: "same" },
      options: OPTIONS,
    },
    {
      type: "permission_response",
      sessionId: SID,
      requestId: "r1",
      decision: "deny",
      optionId: "reject",
      optionKind: "reject_once",
    },
    { type: "runtime_restart", sessionId: SID, reason: "restart" },
    {
      type: "permission_request",
      sessionId: SID,
      requestId: "r2",
      toolName: "Write",
      toolCallId: "tc2",
      input: { file_path: abs("a7.txt"), content: "same" },
      options: OPTIONS,
    },
    {
      type: "permission_response",
      sessionId: SID,
      requestId: "r2",
      decision: "allow",
      optionId: "allow-once",
      optionKind: "allow_once",
    },
    {
      type: "session_update",
      sessionId: SID,
      update: {
        kind: "effect_receipt",
        sink: "fixture_fs",
        path: abs("a7.txt"),
        present: true,
        matched: true,
        expected: "same",
        content: "same",
      },
    },
  ],
};

/** Build filename → JSONL string map (no filesystem writes). */
export function generate_acp_shaped_corpus(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, events] of Object.entries(scenarios)) {
    const history = acp_events_to_history(stamp(events), {
      session_cwd: CWD,
      issuer_id: "acp_adapter_fixture",
    });
    out[name] = history_to_jsonl(history) + "\n";
  }
  return out;
}

function write_files(map: Record<string, string>): void {
  fs.mkdirSync(out_dir, { recursive: true });
  for (const [name, body] of Object.entries(map)) {
    const dest = path.join(out_dir, name);
    fs.writeFileSync(dest, body, "utf8");
    const lines = body.trim().split("\n").filter(Boolean).length;
    console.log(`wrote ${path.relative(path.resolve(here, ".."), dest)} (${lines} events)`);
  }
}

const is_cli =
  process.argv[1] != null && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (is_cli) {
  write_files(generate_acp_shaped_corpus());
}
