/** Client side of the live ACP JSON-RPC stdio connection (permission / fs / session/update handling). */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { observe_event, type AcpPeerEvent } from "./mock_peer.js";
import { build_initialize_v1, build_initialize_v2, build_permission_selected } from "./protocol.js";
import {
  option_kind_for_id,
  pick_allow_always_option,
  pick_allow_option_id,
  pick_deny_option_id,
  pick_reject_always_option,
  type OptionHit,
  type PermissionPickMode,
} from "./permission.js";

export class LiveRpc {
  private readonly pending = new Map<string | number, { resolve: (x: Record<string, unknown>) => void; timer: NodeJS.Timeout }>();
  private buffer = ""; private id = 20; private session = "live-session";
  permission_requests = 0; permission_grants = 0; permission_denies = 0;
  allow_always_absent = 0;
  reject_always_absent = 0;
  fs_write_performed = 0;
  fs_read_served = 0;
  last_selected_option: OptionHit | undefined;
  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly events: AcpPeerEvent[],
    private readonly notes: string[],
    private readonly mode: PermissionPickMode = "allow",
    private readonly cwd: string = process.cwd(),
  ) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (x: string) => this.consume(x));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (x: string) => this.notes.push(`stderr: ${x.trim().slice(0, 300)}`));
  }
  private path_inside_cwd(raw: string): string | undefined {
    const abs = path.resolve(this.cwd, raw);
    const rel = path.relative(this.cwd, abs);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
    return abs;
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
      this.events.push(observe_event({
        type: "permission_request",
        sessionId: this.session,
        requestId: String(id),
        toolName: name,
        input: raw,
        ...(call_id ? { toolCallId: call_id } : {}),
        options: params.options,
      }));
      if (this.mode === "hold") {
        // mid-write-restart: record the request but do not answer — real agent waits here for the client.
        this.notes.push(
          `permission hold: outstanding request_id=${id}` +
            (call_id ? ` toolCallId=${call_id}` : "") +
            ` tool=${name} (no allow/deny/cancel yet)`,
        );
        return;
      }
      if (this.mode === "deny") {
        const reject_opt = pick_deny_option_id(params.options);
        if (reject_opt) {
          this.permission_denies++;
          this.events.push(observe_event({
            type: "permission_response",
            sessionId: this.session,
            requestId: String(id),
            decision: "deny",
            optionId: reject_opt,
            optionKind: option_kind_for_id(params.options, reject_opt),
          }));
          this.write(build_permission_selected(id, reject_opt));
        } else {
          this.permission_denies++;
          this.events.push(observe_event({
            type: "permission_response",
            sessionId: this.session,
            requestId: String(id),
            decision: "cancelled",
            reason: "reject_option_absent",
          }));
          this.write({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
        }
      } else if (this.mode === "allow_always") {
        const always = pick_allow_always_option(params.options);
        if (always) {
          this.permission_grants++;
          this.last_selected_option = always;
          this.events.push(observe_event({
            type: "permission_response",
            sessionId: this.session,
            requestId: String(id),
            decision: "allow",
            optionId: always.id,
            optionKind: always.kind,
          }));
          this.write(build_permission_selected(id, always.id));
        } else {
          this.allow_always_absent++;
          this.permission_denies++;
          this.notes.push(
            "always-grant FAIL: allow_always / allow-always option absent from session/request_permission options — run inconclusive (do not fall back to allow_once)",
          );
          this.events.push(observe_event({
            type: "permission_response",
            sessionId: this.session,
            requestId: String(id),
            decision: "cancelled",
            reason: "allow_always_option_absent",
          }));
          this.write({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
        }
      } else if (this.mode === "reject_always") {
        const always = pick_reject_always_option(params.options);
        if (always) {
          this.permission_denies++;
          this.last_selected_option = always;
          this.events.push(observe_event({
            type: "permission_response",
            sessionId: this.session,
            requestId: String(id),
            decision: "deny",
            optionId: always.id,
            optionKind: always.kind,
          }));
          this.write(build_permission_selected(id, always.id));
        } else {
          this.reject_always_absent++;
          this.permission_denies++;
          this.notes.push(
            "reject-always FAIL: reject_always / reject-always option absent from session/request_permission options — run inconclusive (do not fall back to reject_once)",
          );
          this.events.push(observe_event({
            type: "permission_response",
            sessionId: this.session,
            requestId: String(id),
            decision: "cancelled",
            reason: "reject_always_option_absent",
          }));
          this.write({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
        }
      } else {
        const option = pick_allow_option_id(params.options);
        if (option) {
          const kind = option_kind_for_id(params.options, option);
          this.permission_grants++;
          this.last_selected_option = { id: option, kind: kind ?? "" };
          this.events.push(observe_event({
            type: "permission_response",
            sessionId: this.session,
            requestId: String(id),
            decision: "allow",
            optionId: option,
            ...(kind ? { optionKind: kind } : {}),
          }));
          this.write(build_permission_selected(id, option));
        } else {
          this.permission_denies++;
          this.events.push(observe_event({
            type: "permission_response",
            sessionId: this.session,
            requestId: String(id),
            decision: "cancelled",
            reason: "allow_option_absent",
          }));
          this.write({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
        }
      }
      return;
    }
    if ((method === "fs/read_text_file" || method === "fs/readTextFile") && id !== undefined) {
      const p = (msg.params ?? {}) as Record<string, unknown>;
      const raw_path = String(p.path ?? p.filePath ?? "");
      const abs = this.path_inside_cwd(raw_path);
      if (abs && fs.existsSync(abs)) {
        try {
          const content = fs.readFileSync(abs, "utf8");
          this.fs_read_served++;
          this.write({ jsonrpc: "2.0", id, result: { content } });
          return;
        } catch {
          // fall through to refuse
        }
      }
      this.notes.push(`client fs/read_text_file refused or missing: ${raw_path}`);
      this.write({ jsonrpc: "2.0", id, error: { code: -32602, message: abs ? "file missing" : "path outside session cwd" } });
      return;
    }
    if ((method === "fs/write_text_file" || method === "fs/writeTextFile") && id !== undefined) {
      const p = (msg.params ?? {}) as Record<string, unknown>;
      const raw_path = String(p.path ?? p.filePath ?? "");
      const content = p.content;
      const abs = this.path_inside_cwd(raw_path);
      // Raw request fact (PR-11d A/E9): always record inbound params before perform/refuse.
      this.events.push(observe_event({
        type: "session_update",
        sessionId: this.session,
        update: {
          kind: "fs_write_text_file_request",
          path: raw_path,
          content: typeof content === "string" ? content : null,
          jsonrpc_id: id,
          sessionId: this.session,
        },
      }));
      if (abs && typeof content === "string") {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, "utf8");
        this.fs_write_performed++;
        this.notes.push(`client fs/write_text_file performed: ${abs}`);
        this.events.push(observe_event({
          type: "session_update",
          sessionId: this.session,
          update: {
            kind: "effect_receipt",
            sink: "acp.fs.write_text_file",
            path: raw_path,
            content,
            client_performed_write: true,
          },
        }));
        this.write({ jsonrpc: "2.0", id, result: {} });
        return;
      }
      const message = typeof content !== "string" ? "content must be a string" : "path outside session cwd";
      this.notes.push(`client fs/write_text_file refused: ${raw_path}`);
      this.write({ jsonrpc: "2.0", id, error: { code: -32602, message } });
      return;
    }
    if (method === "session/update" || method === "session/updateNotification") {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const update = (params.update ?? params) as Record<string, unknown>;
      const sessionId = String(params.sessionId ?? this.session);
      const sessionUpdate = update.sessionUpdate ?? update.kind;
      let kind = typeof update.kind === "string" ? update.kind : undefined;
      if (!kind && typeof sessionUpdate === "string") {
        kind = sessionUpdate === "tool_call" || sessionUpdate === "tool_call_update"
          ? String(sessionUpdate)
          : String(sessionUpdate);
      }
      const status = update.status ?? update.toolCallStatus;
      const toolName = update.title ?? update.toolName ?? update.name;
      const toolCallId = update.toolCallId ?? update.tool_call_id;
      this.events.push(observe_event({
        type: "session_update",
        sessionId,
        update: {
          kind: kind ?? "session_update",
          ...(toolName !== undefined ? { toolName: String(toolName) } : {}),
          ...(typeof update.title === "string" ? { title: update.title } : {}),
          ...(status !== undefined ? { status: String(status) } : {}),
          ...(toolCallId !== undefined ? { toolCallId: String(toolCallId) } : {}),
          raw_update: update,
        },
      }));
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
        // Synthetic client wait expiry — not a peer JSON-RPC error. Never score effects from this alone.
        resolve({ jsonrpc: "2.0", id, error: { code: -32000, message: "timeout", data: { harness_client_timeout: true } } });
      }, timeout);
      this.pending.set(id, { resolve, timer });
      this.write(msg);
    });
  }
  /**
   * Drop every outstanding client request timer (e.g. abandoned session/prompt after SIGTERM).
   * Without this, a 180s write-probe timer keeps the Node process alive long after restart.
   */
  cancel_pending(reason = "abandoned"): number {
    const n = this.pending.size;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: reason, data: { harness_client_cancelled: true, reason } },
      });
    }
    this.pending.clear();
    return n;
  }
  next_id(): number { return ++this.id; }
}


export function agent_info_version(result: Record<string, unknown> | undefined): string | undefined {
  const info = result?.agentInfo as Record<string, unknown> | undefined;
  if (!info || typeof info.version !== "string") return undefined;
  return info.version;
}

export async function initialize(
  child: ChildProcessWithoutNullStreams,
  events: AcpPeerEvent[],
  notes: string[],
  timeout: number,
  mode: PermissionPickMode = "allow",
  cwd: string = process.cwd(),
): Promise<{ rpc: LiveRpc; result?: Record<string, unknown> }> {
  const rpc = new LiveRpc(child, events, notes, mode, cwd);
  const first = await rpc.request(build_initialize_v1(1), timeout);
  if ("result" in first) {
    events.push(observe_event({ type: "session_update", sessionId: "live-session", update: { kind: "initialize_result", result: first.result } }));
    return { rpc, result: first.result as Record<string, unknown> };
  }
  const second = await rpc.request(build_initialize_v2(2), timeout);
  if ("result" in second) {
    events.push(observe_event({ type: "session_update", sessionId: "live-session", update: { kind: "initialize_result", result: second.result } }));
    return { rpc, result: second.result as Record<string, unknown> };
  }
  return { rpc };
}
