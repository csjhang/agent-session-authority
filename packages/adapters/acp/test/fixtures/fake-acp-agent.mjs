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
 *                           (.asa-fake-transcript.json is written only when REPLAY_ON_LOAD, REPORT_FAILED_ON_LOAD or
 *                           REPLAY_TERMINAL_ON_LOAD is set)
 * ASA_FAKE_REPORT_FAILED_ON_LOAD "1" = after session/load, emit tool_call_update failed for any
 *                                   tool call that was still pending permission when gen1 died
 * ASA_FAKE_WRITE_WITHOUT_PERMISSION "1" = write the file as soon as permission is requested,
 *                                   without waiting for allow (defect; mid-write-restart probe)
 * ASA_FAKE_NO_TOOLS             "1" = reply to session/prompt with end_turn and never call tools
 *                                   (mid-write never-reached-interrupt invalid-run probe)
 * ASA_FAKE_REPLAY_TERMINAL_ON_LOAD "1" = on session/load, before the load response, emit a
 *                                   failed terminal for pending-permission calls (replay window only)
 * ASA_FAKE_POST_LOAD_AS_TOOL_CALL "1" = with REPORT_FAILED_ON_LOAD, send the post-load failed report as
 *                                   sessionUpdate "tool_call" (ACP kind "edit", status failed) instead of
 *                                   tool_call_update (observed update.kind is then "edit")
 * ASA_FAKE_TOOL_CALL_THEN_PROMPT_ERROR "1" = on a Write prompt, announce a tool_call (kind "edit") and
 *                                   answer session/prompt with JSON-RPC error -32000 (no permission, no write)
 * ASA_FAKE_MODES                 "1" = advertise availableModes; handle session/set_mode
 * ASA_FAKE_PERMISSION_MODE       initial currentModeId (default "default")
 * ASA_FAKE_NEVER_ASK             "1" = skip session/request_permission; still tool_call + write
 * ASA_FAKE_TOOL                  "Write" | "Bash"
 * ASA_FAKE_BASH_CLASS            "fs_command" | "redirect"
 * ASA_FAKE_CLIENT_FS_WITHOUT_PERMISSION "1" = E9: fs/write_text_file without prior permission
 * ASA_FAKE_SETTINGS_SHORT_CIRCUIT "1" = treat cwd settings allow/defaultMode as never-ask
 * ASA_FAKE_LS_THEN_WRITE         "1" = emit Bash ls then Write (strict-link test)
 * ASA_FAKE_DUAL_WRITE_UNLINKABLE "1" = two Write calls for same path (intent-id omit test)
 * ASA_FAKE_REJECT_SET_MODE       "1" = session/set_mode always returns JSON-RPC error
 * ASA_FAKE_FORCE_ASK             "1" = always request permission (overrides mode/settings skip)
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
const post_load_as_tool_call = env.ASA_FAKE_POST_LOAD_AS_TOOL_CALL === "1";
const tool_call_then_prompt_error = env.ASA_FAKE_TOOL_CALL_THEN_PROMPT_ERROR === "1";
const fake_modes = env.ASA_FAKE_MODES === "1";
const permission_mode = env.ASA_FAKE_PERMISSION_MODE ?? "default";
const never_ask = env.ASA_FAKE_NEVER_ASK === "1";
const fake_tool = env.ASA_FAKE_TOOL ?? "Write"; // Write | Bash
const bash_class = env.ASA_FAKE_BASH_CLASS ?? "redirect"; // fs_command | redirect
const client_fs_without_permission = env.ASA_FAKE_CLIENT_FS_WITHOUT_PERMISSION === "1";
const settings_short_circuit = env.ASA_FAKE_SETTINGS_SHORT_CIRCUIT === "1";
const ls_then_write = env.ASA_FAKE_LS_THEN_WRITE === "1";
const dual_write_unlinkable = env.ASA_FAKE_DUAL_WRITE_UNLINKABLE === "1";
const reject_set_mode = env.ASA_FAKE_REJECT_SET_MODE === "1";
const force_ask = env.ASA_FAKE_FORCE_ASK === "1";
const TRANSCRIPT = ".asa-fake-transcript.json";
/**
 * The transcript file is only read back by the session/load modes below; every other mode
 * (default, capped/effect/always-grant runs, WRITE_WITHOUT_PERMISSION, NO_TOOLS, ...) must not
 * leave it in the session cwd.
 */
const need_transcript = replay_on_load || report_failed_on_load || replay_terminal_on_load;

function remember(tool_call_id, title, status) {
  if (!need_transcript) return;
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
    notify_update(
      session_id,
      post_load_as_tool_call
        ? { sessionUpdate: "tool_call", toolCallId: c.tool_call_id, title: c.title, kind: "edit", status: "failed" }
        : { sessionUpdate: "tool_call_update", toolCallId: c.tool_call_id, title: c.title, status: "failed" },
    );
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
let current_mode = permission_mode;
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


const AVAILABLE_MODES = [
  { id: "default", name: "Default", description: "Standard permissions" },
  { id: "acceptEdits", name: "Accept edits", description: "Auto-accept file edits" },
  { id: "plan", name: "Plan", description: "Plan before acting" },
  { id: "auto", name: "Auto", description: "Model-gated" },
  { id: "bypassPermissions", name: "Bypass permissions", description: "Skip permission prompts" },
];

function modes_payload() {
  return { currentModeId: current_mode, availableModes: AVAILABLE_MODES };
}

function should_skip_permission() {
  if (force_ask) return false;
  if (never_ask) return true;
  if (current_mode === "bypassPermissions") return true;
  if (current_mode === "acceptEdits" && fake_tool === "Write") return true;
  if (current_mode === "acceptEdits" && fake_tool === "Bash" && bash_class === "fs_command") return true;
  if (settings_short_circuit) return true;
  return false;
}

function parse_write_prompt(text) {
  // Match "write <file> with exactly: <content>" (existing) or Bash variants.
  let m = /write (?:file )?(\S+) with exactly: (.+?)(?:\.|$)/i.exec(text);
  if (m) return { file: m[1], content: m[2].trim() };
  m = /create empty file (\S+) via touch/i.exec(text);
  if (m) return { file: m[1], content: "" };
  m = /write (\S+) with exactly: (.+)$/i.exec(text);
  if (m) return { file: m[1], content: m[2] };
  return null;
}

function bash_command_for(file, content) {
  if (bash_class === "fs_command") return `touch ${file}`;
  // redirect
  const escaped = content.replace(/'/g, "'\''");
  return `echo '${escaped}' > ${file}`;
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
  const parsed = parse_write_prompt(text);
  // Never call tools — used by mid-write-restart never-reached-interrupt invalid-run probe.
  if (no_tools || !parsed) {
    notify_update(session_id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OK" } });
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    return;
  }
  const file = parsed.file;
  const content = parsed.content;
  const abs = escape_cwd ? path.resolve(session_cwd, "..", file) : path.resolve(session_cwd, file);

  // E9: client fs write without prior permission (and without tool permission).
  if (client_fs_without_permission) {
    await request("fs/write_text_file", { sessionId: session_id, path: abs, content });
    notify_update(session_id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OK" } });
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    return;
  }

  // Strict-link helper: ls then write
  if (ls_then_write) {
    const ls_id = `toolu_fake_${++tool_seq}_${process.pid}`;
    notify_update(session_id, {
      sessionUpdate: "tool_call",
      toolCallId: ls_id,
      title: "Bash",
      kind: "execute",
      status: "completed",
      rawInput: { command: "ls /tmp" },
    });
  }

  async function one_write(tool_call_id, title, kind, rawInput) {
    notify_update(session_id, { sessionUpdate: "tool_call", toolCallId: tool_call_id, title, kind, status: "pending", rawInput });
    if (tool_call_then_prompt_error) {
      send({ jsonrpc: "2.0", id, error: { code: -32000, message: "fake agent prompt error after tool_call" } });
      return false;
    }
    remember(tool_call_id, title, "pending_permission");
    if (write_without_permission) {
      await write_file(session_id, abs, content);
    }
    const skip = should_skip_permission();
    let allowed = skip;
    if (!skip) {
      const resp = await request("session/request_permission", {
        sessionId: session_id,
        toolCall: { toolCallId: tool_call_id, title, kind, rawInput },
        options: permission_options(),
      });
      const outcome = resp?.result?.outcome ?? {};
      const chosen = permission_options().find((o) => o.optionId === outcome.optionId);
      allowed = outcome.outcome === "selected" && chosen != null && chosen.kind.startsWith("allow");
    }
    if (allowed || write_on_reject) {
      const reported = fail_after_write ? "failed" : "completed";
      remember(tool_call_id, title, reported);
      notify_update(session_id, { sessionUpdate: "tool_call_update", toolCallId: tool_call_id, title, status: reported });
      if (claim_without_write) return true;
      if (write_without_permission) return true;
      if (write_delay_ms > 0) setTimeout(() => void write_file(session_id, abs, content), write_delay_ms);
      else await write_file(session_id, abs, content);
      return true;
    }
    remember(tool_call_id, title, "failed");
    notify_update(session_id, { sessionUpdate: "tool_call_update", toolCallId: tool_call_id, title, status: "failed" });
    return false;
  }

  // Intent-id omit test: two Writes for same path (unlinkable exact-one)
  if (dual_write_unlinkable) {
    const a = `toolu_fake_${++tool_seq}_${process.pid}`;
    const b = `toolu_fake_${++tool_seq}_${process.pid}`;
    await one_write(a, `Write ${abs}`, "edit", { file_path: abs, content: content + "-a" });
    if (tool_call_then_prompt_error) return;
    await one_write(b, `Write ${abs}`, "edit", { file_path: abs, content });
    if (tool_call_then_prompt_error) return;
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    return;
  }

  const tool_call_id = `toolu_fake_${++tool_seq}_${process.pid}`;
  if (fake_tool === "Bash") {
    const cmd = bash_command_for(file, content);
    await one_write(tool_call_id, "Bash", "execute", { command: cmd });
    if (tool_call_then_prompt_error) return;
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    return;
  }

  await one_write(tool_call_id, `Write ${abs}`, "edit", { file_path: abs, content });
  if (tool_call_then_prompt_error) return;
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
    const result = { sessionId: "fake-session-1" };
    // Echo CLAUDE_CONFIG_DIR so tests can prove the harness forwarded isolation env.
    if (typeof env.CLAUDE_CONFIG_DIR === "string") {
      result.asa_claude_config_dir = env.CLAUDE_CONFIG_DIR;
    }
    if (fake_modes) {
      result.modes = modes_payload();
      result.configOptions = [{ id: "mode", category: "mode", currentValue: current_mode }];
    }
    send({ jsonrpc: "2.0", id, result });
  } else if (method === "session/set_mode") {
    const modeId = String(params.modeId ?? "");
    if (reject_set_mode) {
      send({ jsonrpc: "2.0", id, error: { code: -32000, message: `fake reject set_mode: ${modeId}` } });
    } else {
    const ok = AVAILABLE_MODES.some((m) => m.id === modeId);
    if (!ok) {
      send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown mode: ${modeId}` } });
    } else {
      current_mode = modeId;
      notify_update(params.sessionId ?? "fake-session-1", { sessionUpdate: "current_mode_update", currentModeId: current_mode });
      send({ jsonrpc: "2.0", id, result: {} });
    }
    }
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
