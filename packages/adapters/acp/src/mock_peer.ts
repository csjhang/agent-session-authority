/** Local mock ACP peer — emits session/permission observables without cloud SDKs. */

export type AcpPeerEvent =
  | { type: "session_update"; sessionId: string; update: Record<string, unknown> }
  | { type: "permission_request"; sessionId: string; requestId: string; toolName: string; input: Record<string, unknown> }
  | { type: "permission_response"; sessionId: string; requestId: string; decision: "allow" | "deny" }
  | { type: "session_closed"; sessionId: string; reason?: string };

export interface MockAcpPeerOptions {
  sessionId?: string;
}

export class MockAcpPeer {
  readonly sessionId: string;
  private seq = 0;
  private readonly events: AcpPeerEvent[] = [];

  constructor(opts: MockAcpPeerOptions = {}) {
    this.sessionId = opts.sessionId ?? "fixture-session-1";
  }

  /** Simulate connect + a short permission round-trip + tool progress. */
  run_fixture_scenario(): AcpPeerEvent[] {
    this.push({
      type: "session_update",
      sessionId: this.sessionId,
      update: { kind: "agent_message_chunk", text: "fixture hello" },
    });
    const requestId = "perm-1";
    this.push({
      type: "permission_request",
      sessionId: this.sessionId,
      requestId,
      toolName: "Write",
      input: { path: "repo/main.ts", content: "hello" },
    });
    this.push({
      type: "permission_response",
      sessionId: this.sessionId,
      requestId,
      decision: "allow",
    });
    this.push({
      type: "session_update",
      sessionId: this.sessionId,
      update: { kind: "tool_call", toolName: "Write", status: "completed" },
    });
    this.push({
      type: "session_closed",
      sessionId: this.sessionId,
      reason: "fixture_done",
    });
    return [...this.events];
  }

  private push(ev: AcpPeerEvent): void {
    this.seq += 1;
    this.events.push(ev);
  }

  get_events(): readonly AcpPeerEvent[] {
    return this.events;
  }
}
