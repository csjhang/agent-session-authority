/**
 * Live (real or fake) ACP agent run: shared setup + gen1 attach, then dispatch to the
 * mid-write-restart branch (live_run_mid_write.ts) or the restart-probe branch
 * (live_run_restart_probe.ts). Split out of index.ts in PR-10c; behaviour unchanged.
 */
import path from "node:path";
import { observe_event, type AcpPeerEvent } from "./mock_peer.js";
import { live_history_from_peer_events } from "./history_from_acp.js";
import type { AcpAdapterOptions } from "./types.js";
import { PINNED, build_session_new } from "./protocol.js";
import type { PermissionPickMode } from "./permission.js";
import { spawn_live, stop } from "./spawn.js";
import { agent_info_version, initialize } from "./live_rpc.js";
import type { LiveRunOutput } from "./live_run_ctx.js";
import { run_mid_write_restart } from "./live_run_mid_write.js";
import { run_restart_probe } from "./live_run_restart_probe.js";

export async function run_live(opts: AcpAdapterOptions, notes: string[]): Promise<LiveRunOutput> {
  const events: AcpPeerEvent[] = [];
  const invalid_reasons: string[] = [];
  let package_version_observed: string | undefined;
  const env = opts.env ?? process.env;
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const timeout = opts.live_observe_ms ?? 4000;
  /** Default post-prompt FS/tool_call grace for write probes (non–always-grant gen2). */
  const effect_grace_ms = opts.effect_grace_ms ?? 20_000;
  /**
   * Write-probe session/prompt client wait. ACP session/prompt often outlives short
   * live_observe_ms (default 4s) because permission + tool execution complete first;
   * the harness synthesizes -32000 when this timer fires. FS receipts remain the score path.
   * Floor via live_observe_ms (collect_history option; no CLI flag).
   */
  const WRITE_PROBE_PROMPT_MS = 180_000;
  /** always-grant / reject-always gen2: bounded wait after prompt returns for tool_call/FS. */
  const ALWAYS_GRANT_EFFECT_POLL_MS = opts.always_grant_poll_ms ?? 30_000;
  const command = opts.live_command ?? "claude-agent-acp";
  const args = opts.live_args ?? [];
  const effect = opts.scenario === "effect";
  const stale = opts.scenario === "stale-grant";
  const stale_effect = opts.scenario === "stale-effect";
  const always_grant = opts.scenario === "always-grant";
  const reject_always = opts.scenario === "reject-always";
  const mid_write = opts.scenario === "mid-write-restart";
  const cross_gen_always = always_grant || reject_always;
  // mid-write-restart is a write probe for the interrupted file only; it does not force a gen2 write.
  const write_probe = effect || stale || stale_effect || always_grant || reject_always;
  const stamp = `${Date.now()}-${process.pid}`;
  // Approach: unique suffixes for ALL write-probe filenames (no pre-delete of fixed names).
  // Avoids leftover-old-file false positives across runs.
  notes.push(
    `target-file approach: unique suffixes (stamp=${stamp}); no pre-delete of fixed names`,
  );
  const first_path = effect
    ? `asa-effect-positive-${stamp}.txt`
    : stale
      ? `asa-stale-grant-positive-${stamp}.txt`
      : stale_effect
        ? `asa-stale-effect-positive-${stamp}.txt`
        : always_grant
          ? `asa-always-grant-positive-${stamp}.txt`
          : reject_always
            ? `asa-reject-always-positive-${stamp}.txt`
            : `asa-capped-probe-${stamp}.txt`;
  const first_content = effect
    ? "asa-effect-positive"
    : stale
      ? "asa-stale-grant-positive"
      : stale_effect
        ? "asa-stale-effect-positive"
        : always_grant
          ? "asa-always-grant-positive"
          : reject_always
            ? "asa-reject-always-positive"
            : "probe";
  const post_path = effect
    ? `asa-effect-${stamp}.txt`
    : stale
      ? `asa-stale-grant-${stamp}.txt`
      : stale_effect
        ? `asa-stale-effect-${stamp}.txt`
        : always_grant
          ? `asa-always-grant-${stamp}.txt`
          : reject_always
            ? `asa-reject-always-${stamp}.txt`
            : `asa-capped-probe-${stamp}.txt`;
  const post_content = effect
    ? `asa-effect-receipt-${stamp}`
    : stale
      ? `asa-stale-grant-receipt-${stamp}`
      : stale_effect
        ? `asa-stale-effect-receipt-${stamp}`
        : always_grant
          ? `asa-always-grant-receipt-${stamp}`
          : reject_always
            ? `asa-reject-always-receipt-${stamp}`
            : "probe";

  const gen1_mode: PermissionPickMode = mid_write ? "hold" : always_grant ? "allow_always" : reject_always ? "reject_always" : "allow";
  const c1 = await spawn_live(command, args, env);
  const i1 = await initialize(c1, events, notes, timeout, gen1_mode, cwd);
  const finish = (extra_notes: string[] = []) => {
    for (const n of extra_notes) notes.push(n);
    const history = live_history_from_peer_events(events);
    return { events, history, package_version_observed, invalid_reasons };
  };
  if (!i1.result) {
    const reason = "initialize returned no result";
    invalid_reasons.push(reason);
    notes.push(`RUN INVALID: ${reason} — no prompt was sent`);
    await stop(c1);
    return finish();
  }
  {
    const ver = agent_info_version(i1.result);
    package_version_observed = ver;
    if (ver !== PINNED) {
      const reason = `claude-agent-acp agentInfo.version=${ver ?? "missing"} != pinned ${PINNED}`;
      invalid_reasons.push(reason);
      notes.push(`RUN INVALID: ${reason} — no prompt was sent`);
      await stop(c1);
      return finish();
    }
    notes.push(`agentInfo.version=${PINNED} matches pin ${PINNED}`);
  }
  const n = await i1.rpc.request(build_session_new(3, cwd), timeout);
  const sid = String((n.result as Record<string, unknown> | undefined)?.sessionId ?? "live-session");
  i1.rpc.set_session(sid);
  events.push(observe_event({ type: "session_update", sessionId: sid, update: { kind: "session_new", cwd, response: n } }));


  const base = {
    events,
    notes,
    invalid_reasons,
    package_version_observed,
    env,
    cwd,
    timeout,
    effect_grace_ms,
    write_probe_prompt_ms: WRITE_PROBE_PROMPT_MS,
    command,
    args,
    stamp,
    sid,
    c1,
    i1,
  };
  if (mid_write) return run_mid_write_restart(base);
  return run_restart_probe({
    ...base,
    effect,
    stale,
    stale_effect,
    always_grant,
    reject_always,
    cross_gen_always,
    write_probe,
    always_grant_effect_poll_ms: ALWAYS_GRANT_EFFECT_POLL_MS,
    first_path,
    first_content,
    post_path,
    post_content,
  });
}
