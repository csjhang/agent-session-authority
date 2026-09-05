/** Local mock Ably AI Transport peer — durable HITL approval. No Ably SDK. */
export type AblyPeerEvent =
  | { type: "session_open"; sessionId: string; channel: string }
  | { type: "run_start"; sessionId: string; runId: string; invocationId: string }
  | { type: "tool_call_pending"; sessionId: string; runId: string; toolCallId: string; toolName: string; input: Record<string, unknown> }
  | { type: "run_suspend"; sessionId: string; runId: string; reason: "tool_approval" }
  | { type: "client_reconnect"; sessionId: string; clientId: string; note: string }
  | { type: "tool_approval_response"; sessionId: string; runId: string; toolCallId: string; decision: "allow" | "deny"; clientId: string; firstResponseWins: boolean; ignored?: boolean }
  | { type: "run_resume"; sessionId: string; runId: string; newInvocationId: string; note: string }
  | { type: "session_closed"; sessionId: string; reason?: string };
export interface MockAblyPeerOptions { sessionId?: string }
export class MockAblyPeer {
  readonly sessionId: string; private readonly events: AblyPeerEvent[] = [];
  constructor(opts: MockAblyPeerOptions = {}) { this.sessionId = opts.sessionId ?? "ably-fixture-session-1"; }
  run_fixture_scenario(): AblyPeerEvent[] { const runId="run-1", toolCallId="toolcall-1";
    this.push({type:"session_open",sessionId:this.sessionId,channel:"ai:fixture-session"}); this.push({type:"run_start",sessionId:this.sessionId,runId,invocationId:"inv-1"});
    this.push({type:"tool_call_pending",sessionId:this.sessionId,runId,toolCallId,toolName:"transfer_funds",input:{amount:100,to:"acct-b"}}); this.push({type:"run_suspend",sessionId:this.sessionId,runId,reason:"tool_approval"});
    this.push({type:"client_reconnect",sessionId:this.sessionId,clientId:"device-phone",note:"pending approval survives reconnect via channel history"});
    this.push({type:"tool_approval_response",sessionId:this.sessionId,runId,toolCallId,decision:"allow",clientId:"device-phone",firstResponseWins:true});
    this.push({type:"tool_approval_response",sessionId:this.sessionId,runId,toolCallId,decision:"deny",clientId:"device-desktop",firstResponseWins:true,ignored:true});
    this.push({type:"run_resume",sessionId:this.sessionId,runId,newInvocationId:"inv-2",note:"resume = new invocation; old approval validity across invocation undefined in docs"}); this.push({type:"session_closed",sessionId:this.sessionId,reason:"fixture_done"}); return [...this.events]; }
  private push(e: AblyPeerEvent): void { this.events.push(e); } get_events(): readonly AblyPeerEvent[] { return this.events; }
}
