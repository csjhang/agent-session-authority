/** Public adapter types (re-exported from index.ts). */
import type { AcpPeerEvent } from "./mock_peer.js";
import type { HistoryEventLite } from "./history_from_acp.js";

export type AdapterMode = "fixture" | "live";
export type AdapterScenario = "initialize" | "capped" | "effect" | "stale-grant" | "stale-effect" | "always-grant" | "reject-always" | "mid-write-restart";
export interface AcpAdapterResult {
  mode: AdapterMode;
  target: "claude-agent-acp";
  package_name: "@agentclientprotocol/claude-agent-acp";
  package_version_pinned: "0.75.1";
  /** Observed agentInfo.version from initialize (live only). */
  package_version_observed?: string;
  /** True when invalid_reasons is empty; fixture mode is always true. */
  run_valid: boolean;
  invalid_reasons: string[];
  events: AcpPeerEvent[];
  history: HistoryEventLite[];
  history_jsonl: string;
  notes: string[];
}
export interface AcpAdapterOptions {
  mode?: AdapterMode;
  scenario?: AdapterScenario;
  cwd?: string;
  live_command?: string;
  live_args?: string[];
  env?: NodeJS.ProcessEnv;
  live_observe_ms?: number;
  /** Post-prompt FS/tool_call grace for write probes (default 20000). */
  effect_grace_ms?: number;
  /** always-grant / reject-always gen2 poll window (default 30000). */
  always_grant_poll_ms?: number;
}
