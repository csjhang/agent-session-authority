/** Public adapter types (re-exported from index.ts). */
import type { AcpPeerEvent } from "./mock_peer.js";
import type { HistoryEventLite } from "./history_from_acp.js";

export type AdapterMode = "fixture" | "live";
export type AdapterScenario =
  | "initialize"
  | "capped"
  | "effect"
  | "stale-grant"
  | "stale-effect"
  | "always-grant"
  | "reject-always"
  | "mid-write-restart"
  | "auth08-p5-default-bash-write"
  | "auth08-p4-settings-allow"
  | "auth08-p4-settings-defaultMode"
  | "auth08-p2-acceptEdits-write"
  | "auth08-p2-acceptEdits-bash-fs-command"
  | "auth08-p2-acceptEdits-bash-redirect"
  | "auth08-p1-bypassPermissions-write"
  | "auth08-e9-client-fs-write";
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
  auth08_run_json?: Record<string, unknown>;
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
  /** Required for live P4/P2/P1 AUTH-08 scenarios that weaken permissions. */
  allow_weakened_permissions?: boolean;
}
