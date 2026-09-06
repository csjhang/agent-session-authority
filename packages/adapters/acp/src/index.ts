import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { MockAcpPeer, type AcpPeerEvent } from "./mock_peer.js";
import { acp_events_to_history, history_to_jsonl, type HistoryEventLite } from "./history_from_acp.js";

export type AdapterMode = "fixture" | "live";

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
  /** LIVE only: executable to spawn (default claude-agent-acp on PATH). */
  live_command?: string;
  live_args?: string[];
  env?: NodeJS.ProcessEnv;
  /** LIVE observe window ms (default 4000). */
  live_observe_ms?: number;
}

const PINNED = "0.75.1" as const;
const PKG = "@agentclientprotocol/claude-agent-acp" as const;

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

/**
 * Spawn/connect path for claude-agent-acp.
 * FIXTURE uses MockAcpPeer. LIVE requires user env key and optional package install.
 */
export async function collect_history(opts: AcpAdapterOptions = {}): Promise<AcpAdapterResult> {
  const mode: AdapterMode = opts.mode ?? "fixture";
  const notes: string[] = [];

  if (mode === "live") {
    const env = opts.env ?? process.env;
    if (!live_key_present(env)) {
      notes.push("LIVE mode requested but ANTHROPIC_API_KEY is missing; refusing to spawn.");
      notes.push("Provide the key in the user environment (never commit it) or use mode=fixture.");
      throw new Error("LIVE ACP requires ANTHROPIC_API_KEY in the environment");
    }
    notes.push("LIVE mode: spawning claude-agent-acp (stdio) with ACP initialize handshake.");
    const child = await spawn_live(opts.live_command ?? "claude-agent-acp", opts.live_args ?? [], env);
    const events = await observe_live_briefly(child, opts.live_observe_ms ?? 4000, notes);
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    const history = acp_events_to_history(events, {
      runtime_generation: 1,
    });
    // mark live issuer in first generation observe if present
    const gen = history.find((e) => e.op === "generation.observe");
    if (gen?.attrs) gen.attrs.issuer_id = "acp_adapter_live";
    const attach = history.find((e) => e.op === "session.attach" && e.kind === "ok");
    if (attach?.attrs) {
      attach.attrs.mode = "live";
      attach.attrs.fidelity = "reconstructed";
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

async function observe_live_briefly(
  child: ChildProcessWithoutNullStreams,
  observe_ms: number,
  notes: string[],
): Promise<AcpPeerEvent[]> {
  const sessionId = "live-session";
  const events: AcpPeerEvent[] = [];
  const deadline = Date.now() + observe_ms;
  let saw_initialize_result = false;
  let saw_initialize_error = false;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  const on_chunk = (chunk: string, stream: "stdout" | "stderr") => {
    for (const msg of try_parse_json_lines(chunk)) {
      const m = msg as Record<string, unknown>;
      if (m && typeof m === "object" && "result" in m && (m.id === 1 || m.id === 2)) {
        saw_initialize_result = true;
        const result = m.result as Record<string, unknown> | undefined;
        notes.push(
          `initialize ok id=${String(m.id)} protocolVersion=${String(result?.protocolVersion ?? result?.protocol_version ?? "?")}`,
        );
        events.push({
          type: "session_update",
          sessionId,
          update: { kind: "initialize_result", result },
        });
        continue;
      }
      if (m && typeof m === "object" && "error" in m && (m.id === 1 || m.id === 2)) {
        saw_initialize_error = true;
        notes.push(`initialize error id=${String(m.id)}: ${JSON.stringify(m.error).slice(0, 300)}`);
        events.push({
          type: "session_update",
          sessionId,
          update: { kind: "initialize_error", error: m.error },
        });
        continue;
      }
      events.push({
        type: "session_update",
        sessionId,
        update: {
          kind: stream === "stdout" ? "stdout_json" : "stderr_json",
          message: m,
        },
      });
    }
    // also keep a truncated raw observe if nothing parsed as structured lines
    if (chunk.trim() && try_parse_json_lines(chunk).length === 0) {
      events.push({
        type: "session_update",
        sessionId,
        update: { kind: `${stream}_chunk`, text: chunk.slice(0, 500) },
      });
    }
  };

  child.stdout.on("data", (chunk: string) => on_chunk(chunk, "stdout"));
  child.stderr.on("data", (chunk: string) => on_chunk(chunk, "stderr"));

  // Prefer ACP v1 first (claude-agent-acp 0.75.x era); then nudge v2 if needed later.
  try {
    child.stdin.write(JSON.stringify(build_initialize_v1(1)) + "\n");
    notes.push("sent initialize protocolVersion=1 (clientInfo + clientCapabilities)");
  } catch (err) {
    notes.push(`failed to write initialize: ${String(err)}`);
  }

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    if (saw_initialize_result || saw_initialize_error) {
      // brief settle for any follow-on lines
      await new Promise((r) => setTimeout(r, 200));
      break;
    }
  }

  // If v1 errored on version, try v2 once within remaining window
  if (saw_initialize_error && !saw_initialize_result && Date.now() < deadline) {
    try {
      child.stdin.write(JSON.stringify(build_initialize_v2(2)) + "\n");
      notes.push("retry initialize protocolVersion=2 (info + capabilities)");
      const retry_deadline = Math.min(deadline, Date.now() + 1500);
      while (Date.now() < retry_deadline) {
        await new Promise((r) => setTimeout(r, 50));
        if (saw_initialize_result) break;
      }
    } catch {
      /* ignore */
    }
  }

  if (events.length === 0) {
    events.push({
      type: "session_update",
      sessionId,
      update: { kind: "spawn_only", text: "no stdout/stderr within observe window" },
    });
  }

  events.push({
    type: "session_closed",
    sessionId,
    reason: saw_initialize_result
      ? "live_initialize_ok"
      : saw_initialize_error
        ? "live_initialize_error"
        : "live_observe_timeout",
  });
  return events;
}

export { MockAcpPeer } from "./mock_peer.js";
export type { AcpPeerEvent } from "./mock_peer.js";
export { acp_events_to_history, history_to_jsonl } from "./history_from_acp.js";
export type { HistoryEventLite } from "./history_from_acp.js";
