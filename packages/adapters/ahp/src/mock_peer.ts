/** Local mock AHP peer — multi-client, tool confirmation, host-death gap. No AHP SDK. */
export type AhpPeerEvent =
  | { type: "client_subscribe"; sessionId: string; clientId: string; serverSeq: number }
  | { type: "state_envelope"; sessionId: string; serverSeq: number; action: string; originClientId?: string }
  | { type: "turn_ownership"; sessionId: string; ownerClientId: string; turnId: string }
  | { type: "tool_confirmation_request"; sessionId: string; requestId: string; toolName: string; input: Record<string, unknown> }
  | { type: "tool_confirmation_response"; sessionId: string; requestId: string; decision: "allow" | "deny"; responderClientId: string; firstWins: boolean; ignored?: boolean }
  | { type: "host_process_death"; sessionId: string; inProgressTurnId?: string; note: string }
  | { type: "session_closed"; sessionId: string; reason?: string };
export interface MockAhpPeerOptions { sessionId?: string; }
export class MockAhpPeer {
  readonly sessionId: string; private serverSeq = 0; private readonly events: AhpPeerEvent[] = [];
  constructor(opts: MockAhpPeerOptions = {}) { this.sessionId = opts.sessionId ?? "ahp-fixture-session-1"; }
  run_fixture_scenario(): AhpPeerEvent[] {
    const clientA = "client-ide-a"; const clientB = "client-agents-window-b";
    this.push({ type: "client_subscribe", sessionId: this.sessionId, clientId: clientA, serverSeq: this.nextSeq() });
    this.push({ type: "client_subscribe", sessionId: this.sessionId, clientId: clientB, serverSeq: this.nextSeq() });
    const turnId = "turn-1";
    this.push({ type: "turn_ownership", sessionId: this.sessionId, ownerClientId: clientA, turnId });
    this.push({ type: "state_envelope", sessionId: this.sessionId, serverSeq: this.nextSeq(), action: "turnStarted", originClientId: clientA });
    const requestId = "confirm-1";
    this.push({ type: "tool_confirmation_request", sessionId: this.sessionId, requestId, toolName: "run_in_terminal", input: { command: "echo fixture" } });
    this.push({ type: "tool_confirmation_response", sessionId: this.sessionId, requestId, decision: "allow", responderClientId: clientA, firstWins: true });
    this.push({ type: "tool_confirmation_response", sessionId: this.sessionId, requestId, decision: "deny", responderClientId: clientB, firstWins: true, ignored: true });
    this.push({ type: "state_envelope", sessionId: this.sessionId, serverSeq: this.nextSeq(), action: "toolCompleted", originClientId: clientA });
    this.push({ type: "host_process_death", sessionId: this.sessionId, inProgressTurnId: "turn-2-orphaned", note: "fixture models in-progress turn fail on host death; cross-restart generation/fencing not defined in public AHP" });
    this.push({ type: "session_closed", sessionId: this.sessionId, reason: "fixture_done" });
    return [...this.events];
  }
  private nextSeq(): number { this.serverSeq += 1; return this.serverSeq; }
  private push(ev: AhpPeerEvent): void { this.events.push(ev); }
  get_events(): readonly AhpPeerEvent[] { return this.events; }
}
