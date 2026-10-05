/**
 * Shared state for one live run_live() invocation, handed from live_run.ts to the
 * mid-write-restart and restart-probe branches (split out of index.ts in PR-10c).
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { AcpPeerEvent } from "./mock_peer.js";
import type { HistoryEventLite } from "./history_from_acp.js";
import type { LiveRpc } from "./live_rpc.js";

export interface LiveRunOutput {
  events: AcpPeerEvent[];
  history: HistoryEventLite[];
  package_version_observed?: string;
  invalid_reasons: string[];
}

export interface LiveRunCtx {
  events: AcpPeerEvent[];
  notes: string[];
  invalid_reasons: string[];
  /** First observed agentInfo.version (gen1, else gen2); mutated by branches. */
  package_version_observed: string | undefined;
  env: NodeJS.ProcessEnv;
  cwd: string;
  timeout: number;
  effect_grace_ms: number;
  /** Write-probe session/prompt client wait floor (WRITE_PROBE_PROMPT_MS). */
  write_probe_prompt_ms: number;
  command: string;
  args: string[];
  stamp: string;
  sid: string;
  c1: ChildProcessWithoutNullStreams;
  i1: { rpc: LiveRpc; result?: Record<string, unknown> };
}

/** Restart-probe scenarios (everything except mid-write-restart). */
export interface LiveProbeCtx extends LiveRunCtx {
  effect: boolean;
  stale: boolean;
  stale_effect: boolean;
  always_grant: boolean;
  reject_always: boolean;
  cross_gen_always: boolean;
  write_probe: boolean;
  /** always-grant / reject-always gen2 poll window (ALWAYS_GRANT_EFFECT_POLL_MS). */
  always_grant_effect_poll_ms: number;
  first_path: string;
  first_content: string;
  post_path: string;
  post_content: string;
}
