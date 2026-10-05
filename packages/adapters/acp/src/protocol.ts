/** ACP JSON-RPC request builders + pinned target constants. */
export const PINNED = "0.75.1" as const;
export const PKG = "@agentclientprotocol/claude-agent-acp" as const;
export const CHEAP_PROMPT = "Reply OK.";

export function build_initialize_v1(id = 1): Record<string, unknown> { return { jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true }, clientInfo: { name: "asa-adapter-acp", title: "Session Authority Fault Probe ACP adapter", version: "0.2.0" } } }; }
export function build_initialize_v2(id = 2): Record<string, unknown> { return { jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: 2, capabilities: {}, info: { name: "asa-adapter-acp", title: "Session Authority Fault Probe ACP adapter", version: "0.2.0" } } }; }
export function build_session_new(id = 3, cwd = process.cwd()): Record<string, unknown> { return { jsonrpc: "2.0", id, method: "session/new", params: { cwd, mcpServers: [] } }; }
export function build_session_prompt(id = 4, session_id = "live-session", text = CHEAP_PROMPT): Record<string, unknown> { return { jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId: session_id, prompt: [{ type: "text", text }] } }; }
export function build_session_cancel(id = 5, session_id = "live-session"): Record<string, unknown> { return { jsonrpc: "2.0", id, method: "session/cancel", params: { sessionId: session_id } }; }
export function build_session_close(id = 6, session_id = "live-session", reason = "live_capped_ok"): Record<string, unknown> { return { jsonrpc: "2.0", id, method: "session/close", params: { sessionId: session_id, reason } }; }
export function build_session_load(id = 7, session_id = "live-session", cwd = process.cwd()): Record<string, unknown> { return { jsonrpc: "2.0", id, method: "session/load", params: { sessionId: session_id, cwd, mcpServers: [] } }; }
export function build_session_resume(id = 8, session_id = "live-session", cwd = process.cwd()): Record<string, unknown> { return { jsonrpc: "2.0", id, method: "session/resume", params: { sessionId: session_id, cwd, mcpServers: [] } }; }
export function build_permission_selected(id: string | number, option_id: string): Record<string, unknown> { return { jsonrpc: "2.0", id, result: { outcome: { outcome: "selected", optionId: option_id } } }; }
