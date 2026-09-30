#!/usr/bin/env node
/**
 * Offline fake ACP agent for live-path tests. Speaks newline-delimited JSON-RPC on stdio.
 * No network, no model: behaviour is fixed by ASA_FAKE_* environment variables.
 *
 * ASA_FAKE_VERSION          agentInfo.version (default "0.75.1"); "none" omits agentInfo
 * ASA_FAKE_OPTIONS          "default" | "no_always" | "with_reject_always"
 * ASA_FAKE_WRITE_DELAY_MS   delay between reporting tool completion and the file landing (default 0)
 * ASA_FAKE_WRITE_VIA_CLIENT "1" = write through the client's fs/write_text_file instead of directly
 * ASA_FAKE_WRITE_ON_REJECT  "1" = write the file even when permission was rejected/cancelled (defect)
 * ASA_FAKE_ECHO_KEY         "1" = echo ANTHROPIC_API_KEY in an agent message (secret-guard test)
 * ASA_FAKE_ESCAPE_CWD       "1" = target the file one directory above the session cwd
 * ASA_FAKE_CLAIM_WITHOUT_WRITE "1" = report the allowed write completed but never write it (defect)
 * ASA_FAKE_FAIL_AFTER_WRITE "1" = write the allowed file but report the tool call failed (defect)
 * ASA_FAKE_REPLAY_ON_LOAD   "1" = on session/load, replay earlier tool calls (from a transcript file in the cwd) before responding
 * ASA_FAKE_REPORT_FAILED_ON_LOAD "1" = after session/load, emit tool_call_update failed for any
 *                                   tool call that was still pending permission when gen1 died
 * ASA_FAKE_WRITE_WITHOUT_PERMISSION "1" = write the file as soon as permission is requested,
 *                                   without waiting for allow (defect; mid-write-restart probe)
 * ASA_FAKE_NO_TOOLS             "1" = reply to session/prompt with end_turn and never call tools
 *                                   (mid-write never-reached-interrupt invalid-run probe)
 * ASA_FAKE_REPLAY_TERMINAL_ON_LOAD "1" = on session/load, before the load response, emit a
 *                                   failed terminal for pending-permission calls (replay window only)
 */

import fs from "node:fs";
import path from "node:path";

const env = process.env;
const version = env.ASA_FAKE_VERSION ?? "0.75.1";
const options_mode = env.ASA_FAKE_OPTIONS ?? "default";
const write_delay_ms = Number(env.ASA_FAKE_WRITE_DELAY_MS ?? "0");
const write_via_client = env.ASA_FAKE_WRITE_VIA_CLIENT === "1";
const write_on_reject = env.ASA_FAKE_WRITE_ON_REJECT === "1";
const echo_key = env.ASA_FAKE_ECHO_KEY === "1";
const escape_cwd = env.ASA_FAKE_ESCAPE_CWD === "1";
const claim_without_write = env.ASA_FAKE_CLAIM_WITHOUT_WRITE === "1";
const fail_after_write = env.ASA_FAKE_FAIL_AFTER_WRITE === "1";
const replay_on_load = env.ASA_FAKE_REPLAY_ON_LOAD === "1";
const report_failed_on_load = env.ASA_FAKE_REPORT_FAILED_ON_LOAD === "1";
const write_without_permission = env.ASA_FAKE_WRITE_WITHOUT_PERMISSION === "1";
const no_tools = env.ASA_FAKE_NO_TOOLS === "1";
const replay_terminal_on_load = env.ASA_FAKE_REPLAY_TERMINAL_ON_LOAD === "1";
const TRANSCRIPT = ".asa-fake-transcript.json";

function remember(tool_call_id, title, status) {
  const file = path.join(session_cwd, TRANSCRIPT);
  const calls = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
  const idx = calls.findIndex((c) => c.tool_call_id === tool_call_id);
  const entry = { tool_call_id, title, status };
  if (idx >= 0) calls[idx] = entry;
  else calls.push(entry);
  fs.writeFileSync(file, JSON.stringify(calls));
}

function transcript_calls() {
  const file = path.join(session_cwd, TRANSCRIPT);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function replay(session_id) {
  for (const c of transcript_calls()) {
    notify_update(session_id, { sessionUpdate: "tool_call", toolCallId: c.tool_call_id, title: c.title, kind: "edit", status: "pending" });
    if (c.status === "pending" || c.status === "pending_permission") continue;
    notify_update(session_id, { sessionUpdate: "tool_call_update", toolCallId: c.tool_call_id, title: c.title, status: c.status });
  }
}

/** Post-load: report failed for tool calls that never got a permission answer (gen1 killed mid-request). */
function report_failed_pending(session_id) {
  for (const c of transcript_calls()) {
    if (c.status !== "pending" && c.status !== "pending_permission") continue;
    notify_update(session_id, {
      sessionUpdate: "tool_call_update",
      toolCallId: c.tool_call_id,
      title: c.title,
      status: "failed",
    });
    remember(c.tool_call_id, c.title, "failed");
  }
}

/**
 * During session/load (before the load response): emit a terminal for pending-permission calls.
 * History marks these as replay (no terminal attr) — first terminal appears only in the replay window.
 */
function replay_terminal_pending(session_id) {
  for (const c of transcript_calls()) {
    if (c.status !== "pending" && c.status !== "pending_permission") continue;
    notify_update(session_id, {
      sessionUpdate: "tool_call",
      toolCallId: c.tool_call_id,
      title: c.title,
      kind: "edit",
      status: "pending",
    });
    notify_update(session_id, {
      sessionUpdate: "tool_call_update",
      toolCallId: c.tool_call_id,
      title: c.title,
      status: "failed",
    });
    remember(c.tool_call_id, c.title, "failed");
  }
}

let session_cwd = process.cwd();
let next_id = 1000;
let tool_seq = 0;
const pending = new Map();

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function request(method, params) {
  const id = next_id++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => pending.set(id, resolve));
}

function notify_update(session_id, update) {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: session_id, update } });
}

function permission_options() {
  const opts = [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }];
  if (options_mode !== "no_always") opts.push({ optionId: "allow-with-updates", name: "Always allow", kind: "allow_always" });
  opts.push({ optionId: "reject", name: "Reject", kind: "reject_once" });
  if (options_mode === "with_reject_always") opts.push({ optionId: "reject-always", name: "Always reject", kind: "reject_always" });
  return opts;
}

async function write_file(session_id, abs, content) {
  if (write_via_client) {
    await request("fs/write_text_file", { sessionId: session_id, path: abs, content });
  } else {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
}

async function handle_prompt(id, params) {
  const session_id = params.sessionId;
  const text = (params.prompt ?? []).map((p) => p.text ?? "").join("\n");
  if (echo_key) {
    notify_update(session_id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `key=${env.ANTHROPIC_API_KEY ?? ""}` } });
  }
  const m = /write (\S+) with exactly: (.*)$/i.exec(text);
  // Never call tools — used by mid-write-restart never-reached-interrupt invalid-run probe.
  if (no_tools || !m) {
    notify_update(session_id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OK" } });
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    return;
  }
  const file = m[1];
  const content = m[2];
  const abs = escape_cwd ? path.resolve(session_cwd, "..", file) : path.resolve(session_cwd, file);
  const tool_call_id = `toolu_fake_${++tool_seq}_${process.pid}`;
  const title = `Write ${abs}`;
  notify_update(session_id, { sessionUpdate: "tool_call", toolCallId: tool_call_id, title, kind: "edit", status: "pending" });
  // Persist before awaiting permission so a mid-request SIGTERM leaves a recoverable transcript for gen2.
  remember(tool_call_id, title, "pending_permission");
  if (write_without_permission) {
    await write_file(session_id, abs, content);
  }
  const resp = await request("session/request_permission", {
    sessionId: session_id,
    toolCall: { toolCallId: tool_call_id, title, kind: "edit", rawInput: { file_path: abs, content } },
    options: permission_options(),
  });
  const outcome = resp?.result?.outcome ?? {};
  const chosen = permission_options().find((o) => o.optionId === outcome.optionId);
  const allowed = outcome.outcome === "selected" && chosen != null && chosen.kind.startsWith("allow");
  if (allowed || write_on_reject) {
    const reported = fail_after_write ? "failed" : "completed";
    remember(tool_call_id, title, reported);
    notify_update(session_id, { sessionUpdate: "tool_call_update", toolCallId: tool_call_id, title, status: reported });
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    if (claim_without_write) return;
    if (write_without_permission) return; // already written
    if (write_delay_ms > 0) setTimeout(() => void write_file(session_id, abs, content), write_delay_ms);
    else await write_file(session_id, abs, content);
    return;
  }
  remember(tool_call_id, title, "failed");
  notify_update(session_id, { sessionUpdate: "tool_call_update", toolCallId: tool_call_id, title, status: "failed" });
  send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
}

function handle(msg) {
  if (msg.id !== undefined && pending.has(msg.id) && ("result" in msg || "error" in msg)) {
    const resolve = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg);
    return;
  }
  const { id, method, params = {} } = msg;
  if (method === "initialize") {
    const result = { protocolVersion: 1, agentCapabilities: { loadSession: true } };
    if (version !== "none") result.agentInfo = { name: "@agentclientprotocol/claude-agent-acp", version };
    send({ jsonrpc: "2.0", id, result });
  } else if (method === "session/new") {
    if (typeof params.cwd === "string") session_cwd = params.cwd;
    send({ jsonrpc: "2.0", id, result: { sessionId: "fake-session-1" } });
  } else if (method === "session/load") {
    if (typeof params.cwd === "string") session_cwd = params.cwd;
    if (replay_on_load) replay(params.sessionId);
    // Replay-window terminal (before load response): treated as replay by history judgment.
    if (replay_terminal_on_load) replay_terminal_pending(params.sessionId);
    send({ jsonrpc: "2.0", id, result: {} });
    // Post-load report (after the load response): maps to silent vs failed post-restart behaviours.
    if (report_failed_on_load) report_failed_pending(params.sessionId);
  } else if (method === "session/prompt") {
    void handle_prompt(id, params);
  } else if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // ignore malformed input
    }
  }
});
process.stdin.on("end", () => process.exit(0));
