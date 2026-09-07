/** Local mock ACP peer — emits session/permission observables without cloud SDKs. */
export type AcpPeerEvent =
  | { type: "session_update"; sessionId: string; update: Record<string, unknown> }
  | { type: "permission_request"; sessionId: string; requestId: string; toolName: string; input: Record<string, unknown>; toolCallId?: string }
  | { type: "permission_response"; sessionId: string; requestId: string; decision: "allow" | "deny" }
  | { type: "session_closed"; sessionId: string; reason?: string };
export interface MockAcpPeerOptions { sessionId?: string; }
export class MockAcpPeer {
  readonly sessionId: string;
  private readonly events: AcpPeerEvent[] = [];
  constructor(opts: MockAcpPeerOptions = {}) { this.sessionId = opts.sessionId ?? "fixture-session-1"; }
  run_fixture_scenario(): AcpPeerEvent[] {
    this.events.push({ type: "session_update", sessionId: this.sessionId, update: { kind: "agent_message_chunk", text: "fixture hello" } });
    this.events.push({ type: "permission_request", sessionId: this.sessionId, requestId: "perm-1", toolName: "Write", input: { path: "repo/main.ts", content: "hello" } });
    this.events.push({ type: "permission_response", sessionId: this.sessionId, requestId: "perm-1", decision: "allow" });
    this.events.push({ type: "session_update", sessionId: this.sessionId, update: { kind: "tool_call", toolName: "Write", status: "completed" } });
    this.events.push({ type: "session_closed", sessionId: this.sessionId, reason: "fixture_done" });
    return [...this.events];
  }
  get_events(): readonly AcpPeerEvent[] { return this.events; }
}

export { MockAcpPeer as default };
