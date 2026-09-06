import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { MockAcpPeer, type AcpPeerEvent } from "./mock_peer.js";
import { acp_events_to_history, history_to_jsonl, type HistoryEventLite } from "./history_from_acp.js";

export type AdapterMode = "fixture" | "live";
export type AdapterScenario = "initialize" | "capped";

export interface AcpAdapterResult {
  mode: AdapterMode;
  target: "claude-agent-acp";
  package_name: "@agentclientprotocol/claude-agent-acp";
  package_version_pinned: "0.75.1";
  events: AcpPeerEvent[];
  history: HistoryEventLite[];
  history_jsonl: string;
  notes: string[];
}

export interface AcpAdapterOptions {
  mode?: AdapterMode;
  scenario?: AdapterScenario;
  cwd?: string;
  /** LIVE only: executable to spawn (default claude-agent-acp on PATH). */
  live_command?: string;
  live_args?: string[];
  env?: NodeJS.ProcessEnv;
  /** LIVE observe/prompt window ms (default 4000). */
  live_observe_ms?: number;
}

const PINNED = "0.75.1" as const;
const PKG = "@agentclientprotocol/claude-agent-acp" as const;
const CHEAP_PROMPT = "Reply OK.";
const WRITE_PROMPT = "Write asa-capped-probe.txt with exactly: probe";

function live_key_present(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.length > 0);
}

/** ACP v1 initialize — widely supported by current agent binaries. */
export function build_initialize_v1(id = 1): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: {
        name: "asa-adapter-acp",
        title: "Session Authority Fault Probe ACP adapter",
        version: "0.2.0",
      },
    },
  };
}

/** ACP v2 initialize — used if agent negotiates/requires v2. */
export function build_initialize_v2(id = 2): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: 2,
      capabilities: {},
      info: {
        name: "asa-adapter-acp",
        title: "Session Authority Fault Probe ACP adapter",
        version: "0.2.0",
      },
    },
  };
}

/** Build ACP session/new with an empty MCP server list. */
export function build_session_new(id = 3, cwd = process.cwd()): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method: "session/new", params: { cwd, mcpServers: [] } };
}

/** Build a short ACP text prompt. */
export function build_session_prompt(
  id = 4,
  session_id = "live-session",
  text = CHEAP_PROMPT,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "session/prompt",
    params: { sessionId: session_id, prompt: [{ type: "text", text }] },
  };
}

export function build_session_cancel(id = 5, session_id = "live-session"): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method: "session/cancel", params: { sessionId: session_id } };
}

export function build_session_close(
  id = 6,
  session_id = "live-session",
  reason = "live_capped_ok",
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method: "session/close", params: { sessionId: session_id, reason } };
}

export function build_session_load(
  id = 7,
  session_id = "live-session",
  cwd = process.cwd(),
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "session/load",
    params: { sessionId: session_id, cwd, mcpServers: [] },
  };
}

export function build_session_resume(
  id = 8,
  session_id = "live-session",
  cwd = process.cwd(),
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method: "session/resume", params: { sessionId: session_id, cwd, mcpServers: [] } };
}

/** Build the ACP response for an allow/deny permission option selection. */
export function build_permission_selected(id: string | number, option_id: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    result: { outcome: { outcome: "selected", optionId: option_id } },
  };
}

/** Return an allow option, preferring the one-shot grant. */
export function pick_allow_option_id(options: unknown): string | undefined {
  if (!Array.isArray(options)) return undefined;
  const normalized = options.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    const id = item.optionId ?? item.option_id ?? item.id;
    return typeof id === "string" ? [{ id, kind: String(item.kind ?? "") }] : [];
  });
  for (const preferred of ["allow_once", "allow_always", "allow"]) {
    const found = normalized.find((item) => item.id === preferred || item.kind === preferred);
    if (found) return found.id;
  }
  return normalized.find((item) => (/allow/i.test(item.id) || /allow/i.test(item.kind)) && !/deny|reject|cancel/i.test(item.id + " " + item.kind))?.id;
}

/** Spawn/connect path for claude-agent-acp. Fixture never imports the target SDK. */
export async function collect_history(opts: AcpAdapterOptions = {}): Promise<AcpAdapterResult> {
  const mode: AdapterMode = opts.mode ?? "fixture";
  const scenario: AdapterScenario = opts.scenario ?? "initialize";
  const notes: string[] = [];

  if (mode === "live") {
    const env = opts.env ?? process.env;
    if (!live_key_present(env)) {
      notes.push("LIVE mode requested but ANTHROPIC_API_KEY is missing; refusing to spawn.");
      notes.push("Provide the key in the user environment (never commit it) or use mode=fixture.");
      throw new Error("LIVE ACP requires ANTHROPIC_API_KEY in the environment");
    }
    notes.push(`LIVE mode: ${scenario} scenario; claude-agent-acp 0.75.1 over stdio.`);
    const output = scenario === "capped"
      ? await run_capped_live(opts, notes)
      : await run_initialize_live(opts, notes);
    return make_live_result(output.events, output.history, notes);
  }

  notes.push("FIXTURE mode: MockAcpPeer (no cloud key, no ACP SDK in core).");
  const peer = new MockAcpPeer();
  const events = peer.run_fixture_scenario();
  const history = acp_events_to_history(events);
  return {
    mode: "fixture",
    target: "claude-agent-acp",
    package_name: PKG,
    package_version_pinned: PINNED,
    events,
    history,
    history_jsonl: history_to_jsonl(history),
    notes,
  };
}

function make_live_result(
  events: AcpPeerEvent[],
  history: HistoryEventLite[],
  notes: string[],
): AcpAdapterResult {
  for (const item of history) {
    if (item.op === "generation.observe" && item.attrs) item.attrs.issuer_id = "acp_adapter_live";
    if (item.op === "session.attach" && item.kind === "ok" && item.attrs) {
      item.attrs.mode = "live";
      item.attrs.fidelity = "reconstructed";
    }
  }
  return {
    mode: "live",
    target: "claude-agent-acp",
    package_name: PKG,
    package_version_pinned: PINNED,
    events,
    history,
    history_jsonl: history_to_jsonl(history),
    notes,
  };
}

function spawn_live(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<ChildProcessWithoutNullStreams> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    child.once("error", reject);
    child.once("spawn", () => resolve(child));
  });
}

function terminate(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(resolve, 500);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

function try_parse_json_lines(chunk: string): unknown[] {
  const out: unknown[] = [];
  for (const line of chunk.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      out.push({ raw: t.slice(0, 500) });
    }
  }
  return out;
}

interface LiveRun {
  events: AcpPeerEvent[];
  initialize?: Record<string, unknown>;
  session_id: string;
  permission_grants: number;
  permission_requests: number;
  restored: boolean;
  close_advertised: boolean;
  saw_protocol: boolean;
}

class LiveRpc {
  private readonly pending = new Map<string | number, { resolve: (value: Record<string, unknown>) => void; timer: NodeJS.Timeout }>();
  private stdout_buffer = "";
  private stderr_buffer = "";
  private next_id = 10;
  private readonly events: AcpPeerEvent[];
  private session_id: string;
  private readonly notes: string[];
  private readonly deny_permissions: boolean;
  permission_grants = 0;
  permission_requests = 0;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    session_id: string,
    events: AcpPeerEvent[],
    notes: string[],
    deny_permissions = false,
  ) {
    this.session_id = session_id;
    this.events = events;
    this.notes = notes;
    this.deny_permissions = deny_permissions;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk, "stdout"));
    child.stderr.on("data", (chunk: string) => this.consume(chunk, "stderr"));
  }

  private consume(chunk: string, stream: "stdout" | "stderr"): void {
    if (stream === "stdout") this.stdout_buffer += chunk;
    else this.stderr_buffer += chunk;
    const buffer = stream === "stdout" ? this.stdout_buffer : this.stderr_buffer;
    const lines = buffer.split(/\r?\n/);
    if (stream === "stdout") this.stdout_buffer = lines.pop() ?? "";
    else this.stderr_buffer = lines.pop() ?? "";
    for (const line of lines) {
      const text = line.trim();
      if (!text) continue;
      let message: unknown;
      try { message = JSON.parse(text); } catch {
        this.events.push({ type: "session_update", sessionId: this.session_id, update: { kind: `${stream}_chunk`, text: text.slice(0, 500) } });
        continue;
      }
      void this.handle(message as Record<string, unknown>, stream);
    }
  }

  private async handle(message: Record<string, unknown>, stream: "stdout" | "stderr"): Promise<void> {
    const id = message.id as string | number | undefined;
    if (("result" in message || "error" in message) && id !== undefined && this.pending.has(id)) {
      const waiter = this.pending.get(id);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.pending.delete(id);
      waiter.resolve(message);
      return;
    }
    const method = typeof message.method === "string" ? message.method : undefined;
    if (method === "session/request_permission" && id !== undefined) {
      const params = (message.params && typeof message.params === "object" ? message.params : {}) as Record<string, unknown>;
      const tool_call = params.toolCall && typeof params.toolCall === "object" ? params.toolCall as Record<string, unknown> : {};
      const tool_name = String(tool_call.title ?? tool_call.name ?? tool_call.kind ?? "permission");
      const input = tool_call.rawInput && typeof tool_call.rawInput === "object" ? tool_call.rawInput as Record<string, unknown> : tool_call;
      this.permission_requests += 1;
      const request_id = String(id);
      this.events.push({ type: "permission_request", sessionId: this.session_id, requestId: request_id, toolName: tool_name, input });
      const option_id = this.deny_permissions ? undefined : pick_allow_option_id(params.options);
      if (option_id) {
        this.permission_grants += 1;
        this.events.push({ type: "permission_response", sessionId: this.session_id, requestId: request_id, decision: "allow" });
        this.write(build_permission_selected(id, option_id));
      } else {
        this.events.push({ type: "permission_response", sessionId: this.session_id, requestId: request_id, decision: "deny" });
        this.write({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
      }
      return;
    }
    if ((method === "fs/read_text_file" || method === "fs/readTextFile") && id !== undefined) {
      this.events.push({ type: "session_update", sessionId: this.session_id, update: { kind: "fs_read_text_file", request: message.params ?? {} } });
      this.write({ jsonrpc: "2.0", id, result: { content: "" } });
      return;
    }
    if ((method === "fs/write_text_file" || method === "fs/writeTextFile") && id !== undefined) {
      this.events.push({ type: "session_update", sessionId: this.session_id, update: { kind: "fs_write_text_file", request: message.params ?? {} } });
      this.write({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    if (method && id !== undefined) {
      this.notes.push(`Unhandled ACP request ${method}; returned empty result.`);
      this.write({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    this.events.push({
      type: "session_update",
      sessionId: this.session_id,
      update: { kind: stream === "stdout" ? String(method ?? "stdout_json") : "stderr_json", message },
    });
  }

  set_session_id(session_id: string): void { this.session_id = session_id; }

  write(message: Record<string, unknown>): void {
    try { this.child.stdin.write(JSON.stringify(message) + "\n"); } catch (error) { this.notes.push(`ACP write failed: ${String(error)}`); }
  }

  request(message: Record<string, unknown>, timeout_ms: number): Promise<Record<string, unknown>> {
    const id = message.id as string | number;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ jsonrpc: "2.0", id, error: { code: -32000, message: "timeout" } });
      }, timeout_ms);
      this.pending.set(id, { resolve, timer });
      this.write(message);
    });
  }

  allocate_id(): number { this.next_id += 1; return this.next_id; }
}

async function initialize_rpc(
  child: ChildProcessWithoutNullStreams,
  events: AcpPeerEvent[],
  notes: string[],
  timeout_ms: number,
  deny_permissions = false,
): Promise<{ rpc: LiveRpc; result?: Record<string, unknown>; protocol: number }> {
  const rpc = new LiveRpc(child, "live-session", events, notes, deny_permissions);
  const first = await rpc.request(build_initialize_v1(1), timeout_ms);
  if ("result" in first) {
    const result = first.result as Record<string, unknown> | undefined;
    notes.push(`initialize ok id=1 protocolVersion=${String(result?.protocolVersion ?? result?.protocol_version ?? "?")}`);
    events.push({ type: "session_update", sessionId: "live-session", update: { kind: "initialize_result", result } });
    return { rpc, result, protocol: Number(result?.protocolVersion ?? 1) };
  }
  notes.push(`initialize error id=1: ${JSON.stringify(first.error).slice(0, 300)}`);
  const second = await rpc.request(build_initialize_v2(2), timeout_ms);
  if ("result" in second) {
    const result = second.result as Record<string, unknown> | undefined;
    notes.push(`initialize ok id=2 protocolVersion=${String(result?.protocolVersion ?? result?.protocol_version ?? "?")}`);
    events.push({ type: "session_update", sessionId: "live-session", update: { kind: "initialize_result", result } });
    return { rpc, result, protocol: Number(result?.protocolVersion ?? 2) };
  }
  notes.push(`initialize error id=2: ${JSON.stringify(second.error).slice(0, 300)}`);
  events.push({ type: "session_update", sessionId: "live-session", update: { kind: "initialize_error", error: second.error } });
  return { rpc, protocol: 1 };
}

async function run_initialize_live(opts: AcpAdapterOptions, notes: string[]): Promise<{ events: AcpPeerEvent[]; history: HistoryEventLite[] }> {
  const child = await spawn_live(opts.live_command ?? "claude-agent-acp", opts.live_args ?? [], opts.env ?? process.env);
  const events: AcpPeerEvent[] = [];
  const initialized = await initialize_rpc(child, events, notes, opts.live_observe_ms ?? 4000);
  if (!initialized.result) events.push({ type: "session_update", sessionId: "live-session", update: { kind: "spawn_only", text: "initialize failed" } });
  await terminate(child);
  events.push({ type: "session_closed", sessionId: "live-session", reason: initialized.result ? "live_initialize_ok" : "live_initialize_error" });
  return { events, history: acp_events_to_history(events, { runtime_generation: 1 }) };
}

function capability(result: Record<string, unknown> | undefined, name: string): boolean {
  const caps = result?.agentCapabilities as Record<string, unknown> | undefined;
  if (!caps) return false;
  if (caps[name] === true || (caps[name] && typeof caps[name] === "object")) return true;
  const session = caps.sessionCapabilities as Record<string, unknown> | undefined;
  return Boolean(session && (session[name] === true || (session[name] && typeof session[name] === "object")));
}

async function run_capped_live(opts: AcpAdapterOptions, notes: string[]): Promise<{ events: AcpPeerEvent[]; history: HistoryEventLite[] }> {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const timeout_ms = opts.live_observe_ms ?? 4000;
  const events: AcpPeerEvent[] = [];
  const generation_histories: HistoryEventLite[][] = [];
  let session_id = "live-session";
  let first_grants = 0;
  let close_advertised = false;
  let restored = false;

  const child1 = await spawn_live(opts.live_command ?? "claude-agent-acp", opts.live_args ?? [], env);
  const init1 = await initialize_rpc(child1, events, notes, timeout_ms);
  const result1 = init1.result;
  if (!result1) {
    notes.push("capped scenario partial: initialize failed");
    await terminate(child1);
    events.push({ type: "session_closed", sessionId: session_id, reason: "live_capped_partial" });
    return { events, history: acp_events_to_history(events, { runtime_generation: 1 }) };
  }
  const new_response = await init1.rpc.request(build_session_new(3, cwd), timeout_ms);
  const new_result = new_response.result as Record<string, unknown> | undefined;
  session_id = String(new_result?.sessionId ?? new_result?.session_id ?? session_id);
  init1.rpc.set_session_id(session_id);
  notes.push(`session/new ${"result" in new_response ? "ok" : "failed"} session=${session_id}`);
  events.push({ type: "session_update", sessionId: session_id, update: { kind: "session_new", response: new_response } });
  const cheap = await init1.rpc.request(build_session_prompt(4, session_id, CHEAP_PROMPT), timeout_ms);
  events.push({ type: "session_update", sessionId: session_id, update: { kind: "prompt_result", prompt: "cheap", response: cheap } });
  if ("error" in cheap) {
    notes.push("cheap prompt hung or failed; sent session/cancel");
    init1.rpc.write(build_session_cancel(init1.rpc.allocate_id(), session_id));
  }
  const write = await init1.rpc.request(build_session_prompt(5, session_id, WRITE_PROMPT), timeout_ms);
  events.push({ type: "session_update", sessionId: session_id, update: { kind: "prompt_result", prompt: "capped_write", response: write } });
  if ("error" in write) {
    notes.push("write prompt hung or failed; sent session/cancel");
    init1.rpc.write(build_session_cancel(init1.rpc.allocate_id(), session_id));
  }
  first_grants = init1.rpc.permission_grants;
  close_advertised = capability(result1, "close");
  generation_histories.push(acp_events_to_history(events, { runtime_generation: 1, fence_epoch: 1 }));
  await terminate(child1);

  notes.push("AUTH-01 RuntimeRestart: terminated generation 1 with SIGTERM; spawning generation 2.");
  const child2 = await spawn_live(opts.live_command ?? "claude-agent-acp", opts.live_args ?? [], env);
  const events_before = events.length;
  const init2 = await initialize_rpc(child2, events, notes, timeout_ms, true);
  const result2 = init2.result;
  init2.rpc.set_session_id(session_id);
  if (result2) {
    if (capability(result2, "loadSession")) {
      const loaded = await init2.rpc.request(build_session_load(6, session_id, cwd), timeout_ms);
      restored = "result" in loaded;
      notes.push(`session/load ${restored ? "ok" : "failed"}`);
      events.push({ type: "session_update", sessionId: session_id, update: { kind: "session_load", response: loaded } });
    } else if (capability(result2, "resume")) {
      const resumed = await init2.rpc.request(build_session_resume(7, session_id, cwd), timeout_ms);
      restored = "result" in resumed;
      notes.push(`session/resume ${restored ? "ok" : "failed"}`);
      events.push({ type: "session_update", sessionId: session_id, update: { kind: "session_resume", response: resumed } });
    } else {
      notes.push("session restoration capability not_declared");
    }
    if (restored && first_grants > 0) {
      const post = await init2.rpc.request(build_session_prompt(8, session_id, "Write asa-capped-probe.txt with exactly: probe"), timeout_ms);
      events.push({ type: "session_update", sessionId: session_id, update: { kind: "prompt_result", prompt: "post_restart_write", response: post } });
      if ("error" in post) init2.rpc.write(build_session_cancel(init2.rpc.allocate_id(), session_id));
      if (init2.rpc.permission_requests > 0) notes.push("generation 2 permission was denied to contrast the stale grant");
    }
    close_advertised = close_advertised || capability(result2, "close");
  }
  if (events.length === events_before && !result2) notes.push("generation 2 initialize failed; capped scenario partial");
  if (init1.rpc.permission_requests === 0) notes.push("permission not_declared: generation 1 emitted no session/request_permission");
  if (first_grants === 0 && init1.rpc.permission_requests > 0) notes.push("generation 1 exposed permission requests but no allow option was declared");
  if (!close_advertised) {
    notes.push("session/close capability not_declared");
  } else {
    const close = await init2.rpc.request(build_session_close(9, session_id, restored ? "live_capped_ok" : "live_capped_partial"), timeout_ms);
    notes.push(`session/close ${"result" in close ? "ok" : "failed"}`);
  }
  await terminate(child2);
  const reason = result2 ? (restored || first_grants === 0 ? "live_capped_ok" : "live_capped_partial") : "live_capped_partial";
  events.push({ type: "session_closed", sessionId: session_id, reason });
  generation_histories.push(acp_events_to_history(events.slice(events_before), { runtime_generation: 2, fence_epoch: 2 }));
  const history: HistoryEventLite[] = [];
  for (const batch of generation_histories) for (const item of batch) history.push({ ...item, seq: history.length + 1 });
  return { events, history };
}

export { MockAcpPeer } from "./mock_peer.js";
export type { AcpPeerEvent } from "./mock_peer.js";
export { acp_events_to_history, history_to_jsonl } from "./history_from_acp.js";
export type { HistoryEventLite } from "./history_from_acp.js";
