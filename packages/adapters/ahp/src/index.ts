import { MockAhpPeer, type AhpPeerEvent } from "./mock_peer.js";
import { ahp_events_to_history, history_to_jsonl, type HistoryEventLite } from "./history_from_ahp.js";
export type AdapterMode = "fixture" | "live";
export interface AhpAdapterResult { mode: AdapterMode; target: "vscode-agent-host"; protocol: "AHP"; events: AhpPeerEvent[]; history: HistoryEventLite[]; history_jsonl: string; notes: string[]; }
export interface AhpAdapterOptions { mode?: AdapterMode; ahp_ws_url?: string; env?: NodeJS.ProcessEnv; }
export async function collect_history(opts: AhpAdapterOptions = {}): Promise<AhpAdapterResult> {
  const mode: AdapterMode = opts.mode ?? "fixture"; const notes: string[] = [];
  if (mode === "live") {
    const env = opts.env ?? process.env; const url = opts.ahp_ws_url ?? env.AHP_WS_URL ?? env.VSCODE_AHP_URL;
    notes.push("LIVE mode: optional attach to a running VS Code Agent Host via AHP WebSocket.");
    notes.push("How to attach: enable chat.agentHost.enabled; run code agent host; set AHP_WS_URL.");
    notes.push("Or use @microsoft/agent-host-protocol client against the host.");
    if (!url) { notes.push("AHP_WS_URL / VSCODE_AHP_URL missing; refusing live attach."); throw new Error("LIVE AHP requires AHP_WS_URL (or VSCODE_AHP_URL) pointing at a running Agent Host"); }
    notes.push("AHP_WS_URL present; live wire capture not implemented in Week 3 — use fixture.");
    throw new Error("LIVE AHP wire capture not implemented; fixture mode produces Week-3 vectors");
  }
  notes.push("FIXTURE mode: MockAhpPeer (no VS Code, no AHP SDK in core).");
  const peer = new MockAhpPeer(); const events = peer.run_fixture_scenario(); const history = ahp_events_to_history(events);
  return { mode: "fixture", target: "vscode-agent-host", protocol: "AHP", events, history, history_jsonl: history_to_jsonl(history), notes };
}
export { MockAhpPeer } from "./mock_peer.js";
export type { AhpPeerEvent } from "./mock_peer.js";
export { ahp_events_to_history, history_to_jsonl } from "./history_from_ahp.js";
export type { HistoryEventLite } from "./history_from_ahp.js";
