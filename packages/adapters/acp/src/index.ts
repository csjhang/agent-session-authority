import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { MockAcpPeer, type AcpPeerEvent } from "./mock_peer.js";
import { acp_events_to_history, history_to_jsonl, type HistoryEventLite } from "./history_from_acp.js";

export type AdapterMode = "fixture" | "live";
export type AdapterScenario = "initialize" | "capped" | "effect" | "stale-grant" | "stale-effect" | "always-grant";
export interface AcpAdapterResult { mode: AdapterMode; target: "claude-agent-acp"; package_name: "@agentclientprotocol/claude-agent-acp"; package_version_pinned: "0.75.1"; events: AcpPeerEvent[]; history: HistoryEventLite[]; history_jsonl: string; notes: string[]; }
export interface AcpAdapterOptions { mode?: AdapterMode; scenario?: AdapterScenario; cwd?: string; live_command?: string; live_args?: string[]; env?: NodeJS.ProcessEnv; live_observe_ms?: number; }
const PINNED = "0.75.1" as const;
const PKG = "@agentclientprotocol/claude-agent-acp" as const;
const CHEAP_PROMPT = "Reply OK.";

type PermissionPickMode = "allow" | "deny" | "allow_always";
type OptionHit = { id: string; kind: string };

function parse_permission_options(options: unknown): OptionHit[] {
  if (!Array.isArray(options)) return [];
  return options.flatMap((v) => {
    if (!v || typeof v !== "object") return [];
    const x = v as Record<string, unknown>;
    const id = x.optionId ?? x.option_id ?? x.id;
    return typeof id === "string" ? [{ id, kind: String(x.kind ?? "") }] : [];
  });
}

export function build_initialize_v1(id = 1): Record<string, unknown> { return { jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true }, clientInfo: { name: "asa-adapter-acp", title: "Session Authority Fault Probe ACP adapter", version: "0.2.0" } } }; }
export function build_initialize_v2(id = 2): Record<string, unknown> { return { jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: 2, capabilities: {}, info: { name: "asa-adapter-acp", title: "Session Authority Fault Probe ACP adapter", version: "0.2.0" } } }; }
export function build_session_new(id = 3, cwd = process.cwd()): Record<string, unknown> { return { jsonrpc: "2.0", id, method: "session/new", params: { cwd, mcpServers: [] } }; }
export function build_session_prompt(id = 4, session_id = "live-session", text = CHEAP_PROMPT): Record<string, unknown> { return { jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId: session_id, prompt: [{ type: "text", text }] } }; }
export function build_session_cancel(id = 5, session_id = "live-session"): Record<string, unknown> { return { jsonrpc: "2.0", id, method: "session/cancel", params: { sessionId: session_id } }; }
export function build_session_close(id = 6, session_id = "live-session", reason = "live_capped_ok"): Record<string, unknown> { return { jsonrpc: "2.0", id, method: "session/close", params: { sessionId: session_id, reason } }; }
export function build_session_load(id = 7, session_id = "live-session", cwd = process.cwd()): Record<string, unknown> { return { jsonrpc: "2.0", id, method: "session/load", params: { sessionId: session_id, cwd, mcpServers: [] } }; }
export function build_session_resume(id = 8, session_id = "live-session", cwd = process.cwd()): Record<string, unknown> { return { jsonrpc: "2.0", id, method: "session/resume", params: { sessionId: session_id, cwd, mcpServers: [] } }; }
export function build_permission_selected(id: string | number, option_id: string): Record<string, unknown> { return { jsonrpc: "2.0", id, result: { outcome: { outcome: "selected", optionId: option_id } } }; }

export function pick_allow_option_id(options: unknown): string | undefined {
  const values = parse_permission_options(options);
  for (const preferred of ["allow_once", "allow_always", "allow"]) {
    const hit = values.find((x) => x.id === preferred || x.kind === preferred || x.id.replace(/-/g, "_") === preferred);
    if (hit) return hit.id;
  }
  return values.find((x) => /allow/i.test(x.id) && !/deny|reject|cancel/i.test(x.id))?.id;
}

/**
 * Prefer explicit allow_always / allow-always kind.
 * claude-agent-acp Write typically offers optionId=allow-with-updates with kind=allow_always
 * when a durableChangeSet is present; otherwise the option may be absent.
 */
export function pick_allow_always_option_id(options: unknown): string | undefined {
  return pick_allow_always_option(options)?.id;
}

/** Return optionId + kind for allow_always selection (for notes/history attrs). */
export function pick_allow_always_option(options: unknown): OptionHit | undefined {
  const values = parse_permission_options(options);
  for (const preferred of ["allow_always", "allow-always"]) {
    const norm = preferred.replace(/-/g, "_");
    const hit = values.find(
      (x) =>
        x.kind === preferred ||
        x.kind === norm ||
        x.kind.replace(/-/g, "_") === norm ||
        x.id === preferred ||
        x.id.replace(/-/g, "_") === norm,
    );
    if (hit) return hit;
  }
  // ACP filesystem Write uses optionId allow-with-updates with kind allow_always
  const by_updates = values.find((x) => x.id === "allow-with-updates" || x.id === "allow_with_updates");
  if (by_updates && /allow_always|allow-always/i.test(by_updates.kind)) return by_updates;
  return undefined;
}

/** Prefer explicit ACP reject/deny option (claude-agent-acp uses optionId=reject, kind=reject_once). */
export function pick_deny_option_id(options: unknown): string | undefined {
  const values = parse_permission_options(options);
  for (const preferred of ["reject", "reject_once", "deny", "reject_always", "cancel"]) {
    const hit = values.find((x) => x.id === preferred || x.kind === preferred || x.id.replace(/-/g, "_") === preferred);
    if (hit) return hit.id;
  }
  return values.find((x) => /deny|reject|cancel/i.test(x.id) || /deny|reject|cancel/i.test(x.kind))?.id;
}

function option_kind_for_id(options: unknown, option_id: string): string | undefined {
  return parse_permission_options(options).find((x) => x.id === option_id)?.kind;
}

function has_key(env: NodeJS.ProcessEnv): boolean { return Boolean(env.ANTHROPIC_API_KEY); }
function spawn_live(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<ChildProcessWithoutNullStreams> { return new Promise((resolve, reject) => { const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] }); child.once("error", reject); child.once("spawn", () => resolve(child)); }); }
function stop(child: ChildProcessWithoutNullStreams): Promise<void> { return new Promise((resolve) => { if (child.exitCode !== null) return resolve(); const t = setTimeout(resolve, 500); child.once("exit", () => { clearTimeout(t); resolve(); }); try { child.kill("SIGTERM"); } catch { clearTimeout(t); resolve(); } }); }

class LiveRpc {
  private readonly pending = new Map<string | number, { resolve: (x: Record<string, unknown>) => void; timer: NodeJS.Timeout }>();
  private buffer = ""; private id = 20; private session = "live-session";
  permission_requests = 0; permission_grants = 0; permission_denies = 0;
  allow_always_absent = 0;
  last_selected_option: OptionHit | undefined;
  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly events: AcpPeerEvent[],
    private readonly notes: string[],
    private readonly mode: PermissionPickMode = "allow",
  ) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (x: string) => this.consume(x));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (x: string) => this.notes.push(`stderr: ${x.trim().slice(0, 300)}`));
  }
  private consume(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      void this.handle(msg);
    }
  }
  private async handle(msg: Record<string, unknown>): Promise<void> {
    const id = msg.id as string | number | undefined;
    if (("result" in msg || "error" in msg) && id !== undefined && this.pending.has(id)) {
      const p = this.pending.get(id)!;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.resolve(msg);
      return;
    }
    const method = typeof msg.method === "string" ? msg.method : "";
    if (method === "session/request_permission" && id !== undefined) {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const call = (params.toolCall ?? {}) as Record<string, unknown>;
      const raw = (call.rawInput ?? call) as Record<string, unknown>;
      const name = String(call.title ?? call.name ?? "permission");
      const call_id = typeof call.toolCallId === "string" ? call.toolCallId : undefined;
      this.permission_requests++;
      this.events.push({
        type: "permission_request",
        sessionId: this.session,
        requestId: String(id),
        toolName: name,
        input: raw,
        ...(call_id ? { toolCallId: call_id } : {}),
        options: params.options,
      });
      if (this.mode === "deny") {
        const reject_opt = pick_deny_option_id(params.options);
        this.permission_denies++;
        this.events.push({
          type: "permission_response",
          sessionId: this.session,
          requestId: String(id),
          decision: "deny",
          ...(reject_opt ? { optionId: reject_opt, optionKind: option_kind_for_id(params.options, reject_opt) } : {}),
        });
        if (reject_opt) this.write(build_permission_selected(id, reject_opt));
        else this.write({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
      } else if (this.mode === "allow_always") {
        const always = pick_allow_always_option(params.options);
        if (always) {
          this.permission_grants++;
          this.last_selected_option = always;
          this.events.push({
            type: "permission_response",
            sessionId: this.session,
            requestId: String(id),
            decision: "allow",
            optionId: always.id,
            optionKind: always.kind,
          });
          this.write(build_permission_selected(id, always.id));
        } else {
          this.allow_always_absent++;
          this.permission_denies++;
          this.notes.push(
            "always-grant FAIL: allow_always / allow-always option absent from session/request_permission options — run inconclusive (do not fall back to allow_once)",
          );
          this.events.push({
            type: "permission_response",
            sessionId: this.session,
            requestId: String(id),
            decision: "deny",
          });
          this.write({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
        }
      } else {
        const option = pick_allow_option_id(params.options);
        if (option) {
          const kind = option_kind_for_id(params.options, option);
          this.permission_grants++;
          this.last_selected_option = { id: option, kind: kind ?? "" };
          this.events.push({
            type: "permission_response",
            sessionId: this.session,
            requestId: String(id),
            decision: "allow",
            optionId: option,
            ...(kind ? { optionKind: kind } : {}),
          });
          this.write(build_permission_selected(id, option));
        } else {
          this.permission_denies++;
          this.events.push({ type: "permission_response", sessionId: this.session, requestId: String(id), decision: "deny" });
          this.write({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
        }
      }
      return;
    }
    if ((method === "fs/read_text_file" || method === "fs/readTextFile") && id !== undefined) {
      this.write({ jsonrpc: "2.0", id, result: { content: "" } });
      return;
    }
    if ((method === "fs/write_text_file" || method === "fs/writeTextFile") && id !== undefined) {
      const p = (msg.params ?? {}) as Record<string, unknown>;
      this.events.push({
        type: "session_update",
        sessionId: this.session,
        update: { kind: "effect_receipt", sink: "acp.fs.write_text_file", path: String(p.path ?? p.filePath ?? ""), content: p.content, request: p },
      });
      this.write({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    if (method && id !== undefined) this.write({ jsonrpc: "2.0", id, result: {} });
  }
  set_session(id: string): void { this.session = id; }
  write(msg: Record<string, unknown>): void {
    try { this.child.stdin.write(JSON.stringify(msg) + "\n"); }
    catch (e) { this.notes.push(`ACP write failed: ${String(e)}`); }
  }
  request(msg: Record<string, unknown>, timeout: number): Promise<Record<string, unknown>> {
    const id = msg.id as string | number;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ jsonrpc: "2.0", id, error: { code: -32000, message: "timeout" } });
      }, timeout);
      this.pending.set(id, { resolve, timer });
      this.write(msg);
    });
  }
  next_id(): number { return ++this.id; }
}
