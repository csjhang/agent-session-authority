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
}

const PINNED = "0.75.1" as const;
const PKG = "@agentclientprotocol/claude-agent-acp" as const;

function live_key_present(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.length > 0);
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
    notes.push("LIVE mode: spawning claude-agent-acp (stdio). Observation is best-effort.");
    const child = await spawn_live(opts.live_command ?? "claude-agent-acp", opts.live_args ?? [], env);
    // Best-effort: send initialize-ish stdin and collect a short window of stdout lines as opaque updates.
    const events = await observe_live_briefly(child);
    child.kill("SIGTERM");
    const history = acp_events_to_history(events);
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

async function observe_live_briefly(child: ChildProcessWithoutNullStreams): Promise<AcpPeerEvent[]> {
  const sessionId = "live-session";
  const events: AcpPeerEvent[] = [];
  const deadline = Date.now() + 1500;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    events.push({
      type: "session_update",
      sessionId,
      update: { kind: "stdout_chunk", text: chunk.slice(0, 500) },
    });
  });
  // nudge process; real ACP handshake is JSON-RPC — here we only prove spawn/connect path
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  } catch {
    /* ignore */
  }
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    if (events.length > 0) break;
  }
  if (events.length === 0) {
    events.push({
      type: "session_update",
      sessionId,
      update: { kind: "spawn_only", text: "no stdout within brief window" },
    });
  }
  events.push({ type: "session_closed", sessionId, reason: "live_brief_window" });
  return events;
}

export { MockAcpPeer } from "./mock_peer.js";
export type { AcpPeerEvent } from "./mock_peer.js";
export { acp_events_to_history, history_to_jsonl } from "./history_from_acp.js";
export type { HistoryEventLite } from "./history_from_acp.js";
