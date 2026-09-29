/** Local mock ACP peer — emits session/permission observables without cloud SDKs. */
export type AcpPeerEvent =
  | {
      type: "session_update";
      sessionId: string;
      update: Record<string, unknown>;
      observed_at_ms?: number;
    }
  | {
      type: "permission_request";
      sessionId: string;
      requestId: string;
      toolName: string;
      input: Record<string, unknown>;
      toolCallId?: string;
      options?: unknown;
      observed_at_ms?: number;
    }
  | {
      type: "permission_response";
      sessionId: string;
      requestId: string;
      decision: "allow" | "deny";
      optionId?: string;
      optionKind?: string;
      observed_at_ms?: number;
    }
  | {
      /** New process spawn after the initial attach — converter emits fault + gen+1. */
      type: "runtime_restart";
      sessionId: string;
      reason?: string;
      observed_at_ms?: number;
    }
  | { type: "session_closed"; sessionId: string; reason?: string; observed_at_ms?: number };

/** Stamp Date.now() at every push into an events buffer (mock + live). */
export function observe_event<E extends AcpPeerEvent>(ev: E): E & { observed_at_ms: number } {
  return { ...ev, observed_at_ms: Date.now() };
}

export interface MockAcpPeerOptions {
  sessionId?: string;
}

export class MockAcpPeer {
  readonly sessionId: string;
  private readonly events: AcpPeerEvent[] = [];
  constructor(opts: MockAcpPeerOptions = {}) {
    this.sessionId = opts.sessionId ?? "fixture-session-1";
  }

  private push(ev: AcpPeerEvent): void {
    this.events.push(observe_event(ev));
  }

  run_fixture_scenario(): AcpPeerEvent[] {
    this.push({
      type: "session_update",
      sessionId: this.sessionId,
      update: { kind: "agent_message_chunk", text: "fixture hello" },
    });
    this.push({
      type: "permission_request",
      sessionId: this.sessionId,
      requestId: "perm-1",
      toolName: "Write",
      input: { path: "repo/main.ts", content: "hello" },
      options: [
        { optionId: "allow-once", kind: "allow_once" },
        { optionId: "allow-with-updates", kind: "allow_always" },
        { optionId: "reject", kind: "reject_once" },
      ],
    });
    this.push({
      type: "permission_response",
      sessionId: this.sessionId,
      requestId: "perm-1",
      decision: "allow",
      optionId: "allow-once",
      optionKind: "allow_once",
    });
    this.push({
      type: "session_update",
      sessionId: this.sessionId,
      update: {
        kind: "effect_receipt",
        sink: "fixture_fs",
        path: "repo/main.ts",
        present: true,
        matched: true,
        expected: "hello",
        content: "hello",
      },
    });
    this.push({
      type: "session_update",
      sessionId: this.sessionId,
      update: { kind: "tool_call", toolName: "Write", status: "completed" },
    });
    this.push({ type: "session_closed", sessionId: this.sessionId, reason: "fixture_done" });
    return [...this.events];
  }

  /**
   * Fixture simulating one process restart: gen1 Write + grant + effect,
   * runtime_restart, then gen2 Write + grant + effect. Used to assert
   * multi-generation history encoding without a live peer.
   */
  run_restart_fixture_scenario(): AcpPeerEvent[] {
    const options = [
      { optionId: "allow-once", kind: "allow_once" },
      { optionId: "allow-with-updates", kind: "allow_always" },
      { optionId: "reject", kind: "reject_once" },
    ];
    this.push({
      type: "session_update",
      sessionId: this.sessionId,
      update: { kind: "session_new", note: "gen1" },
    });
    this.push({
      type: "permission_request",
      sessionId: this.sessionId,
      requestId: "perm-gen1",
      toolName: "Write",
      toolCallId: "tc-gen1",
      input: { path: "repo/gen1.txt", content: "gen1" },
      options,
    });
    this.push({
      type: "permission_response",
      sessionId: this.sessionId,
      requestId: "perm-gen1",
      decision: "allow",
      optionId: "allow-once",
      optionKind: "allow_once",
    });
    this.push({
      type: "session_update",
      sessionId: this.sessionId,
      update: {
        kind: "effect_receipt",
        sink: "fixture_fs",
        path: "repo/gen1.txt",
        present: true,
        matched: true,
        expected: "gen1",
        content: "gen1",
      },
    });
    this.push({
      type: "runtime_restart",
      sessionId: this.sessionId,
      reason: "fixture_SIGTERM_gen1",
    });
    this.push({
      type: "session_update",
      sessionId: this.sessionId,
      update: { kind: "session_load", note: "gen2" },
    });
    this.push({
      type: "permission_request",
      sessionId: this.sessionId,
      requestId: "perm-gen2",
      toolName: "Write",
      toolCallId: "tc-gen2",
      input: { path: "repo/gen2.txt", content: "gen2" },
      options,
    });
    this.push({
      type: "permission_response",
      sessionId: this.sessionId,
      requestId: "perm-gen2",
      decision: "allow",
      optionId: "allow-once",
      optionKind: "allow_once",
    });
    this.push({
      type: "session_update",
      sessionId: this.sessionId,
      update: {
        kind: "effect_receipt",
        sink: "fixture_fs",
        path: "repo/gen2.txt",
        present: true,
        matched: true,
        expected: "gen2",
        content: "gen2",
      },
    });
    this.push({
      type: "session_closed",
      sessionId: this.sessionId,
      reason: "fixture_restart_done",
    });
    return [...this.events];
  }

  get_events(): readonly AcpPeerEvent[] {
    return this.events;
  }
}

export { MockAcpPeer as default };
