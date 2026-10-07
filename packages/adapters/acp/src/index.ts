/**
 * @asa/adapter-acp public surface. Implementation is split across modules (PR-10c):
 *   types.ts, protocol.ts, permission.ts, tool_update.ts, spawn.ts, live_rpc.ts,
 *   live_run.ts (+ live_run_mid_write.ts, live_run_restart_probe.ts, live_run_gen2_report.ts).
 * Exports from this file are unchanged.
 */
import { MockAcpPeer } from "./mock_peer.js";
import { acp_events_to_history, history_to_jsonl } from "./history_from_acp.js";
import type { AcpAdapterOptions, AcpAdapterResult } from "./types.js";
import { PINNED, PKG } from "./protocol.js";
import { has_key } from "./spawn.js";
import { run_live } from "./live_run.js";

export type { AdapterMode, AdapterScenario, AcpAdapterResult, AcpAdapterOptions } from "./types.js";
export {
  build_initialize_v1,
  build_initialize_v2,
  build_session_new,
  build_session_prompt,
  build_session_cancel,
  build_session_close,
  build_session_load,
  build_session_resume,
  build_permission_selected,
} from "./protocol.js";
export {
  pick_allow_option_id,
  pick_allow_always_option_id,
  pick_allow_always_option,
  pick_reject_always_option_id,
  pick_reject_always_option,
  pick_deny_option_id,
} from "./permission.js";

export async function collect_history(opts: AcpAdapterOptions = {}): Promise<AcpAdapterResult> {
  const mode = opts.mode ?? "fixture";
  const scenario = opts.scenario ?? "initialize";
  const notes: string[] = [];
  if (mode === "live") {
    if (!has_key(opts.env ?? process.env)) throw new Error("LIVE ACP requires ANTHROPIC_API_KEY in the environment");
    const out = await run_live(opts, notes);
    const history = out.history;
    const invalid_reasons = out.invalid_reasons;
    return {
      mode,
      target: "claude-agent-acp",
      package_name: PKG,
      package_version_pinned: PINNED,
      ...(out.package_version_observed !== undefined
        ? { package_version_observed: out.package_version_observed }
        : {}),
      run_valid: invalid_reasons.length === 0,
      invalid_reasons,
      events: out.events,
      history,
      history_jsonl: history_to_jsonl(history),
      notes,
      ...(out.auth08_run_json ? { auth08_run_json: out.auth08_run_json } : {}),
    };
  }
  notes.push("FIXTURE mode: MockAcpPeer (no cloud key, no ACP SDK in core).");
  if (scenario === "always-grant") {
    notes.push("FIXTURE always-grant: mock peer includes allow-with-updates (kind=allow_always); live run selects it explicitly via pick_allow_always_option");
  }
  if (scenario === "reject-always") {
    notes.push("FIXTURE reject-always: cheap fixture note only — live run requires reject_always / reject-always option via pick_reject_always_option (strict; no reject_once fallback); mock peer may list reject_once without reject_always");
  }
  if (scenario === "mid-write-restart") {
    notes.push("FIXTURE mid-write-restart: cheap fixture note only — live/fake run SIGTERMs while Write permission is outstanding (before allow), then session/load + disk probe without a forced gen2 write");
  }
  const events = new MockAcpPeer().run_fixture_scenario();
  const history = acp_events_to_history(events, { session_cwd: opts.cwd });
  return {
    mode,
    target: "claude-agent-acp",
    package_name: PKG,
    package_version_pinned: PINNED,
    run_valid: true,
    invalid_reasons: [],
    events,
    history,
    history_jsonl: history_to_jsonl(history),
    notes,
  };
}
export { MockAcpPeer } from "./mock_peer.js";
export { observe_event } from "./mock_peer.js";
export type { AcpPeerEvent } from "./mock_peer.js";
export { acp_events_to_history, history_to_jsonl, live_history_from_peer_events } from "./history_from_acp.js";
export type { HistoryEventLite } from "./history_from_acp.js";
export { check_live_run, check_live_runs, write_live_runs } from "./live_reconvert.js";
export type { LiveReconvertCheck } from "./live_reconvert.js";
