/**
 * mid-write-restart: SIGTERM generation 1 while a Write session/request_permission is
 * outstanding (before allow/deny/cancel), then gen2 initialize + session/load + disk probe
 * for the interrupted file only (no forced second write). Split out of index.ts in PR-10c.
 */
import fs from "node:fs";
import path from "node:path";
import { observe_event } from "./mock_peer.js";
import { sleep, wait_for_write_effect } from "./effect_wait.js";
import { live_history_from_peer_events } from "./history_from_acp.js";
import { PINNED, build_session_load, build_session_prompt } from "./protocol.js";
import { is_tool_call_session_update } from "./tool_update.js";
import { spawn_live, stop } from "./spawn.js";
import { agent_info_version, initialize } from "./live_rpc.js";
import type { LiveRunCtx, LiveRunOutput } from "./live_run_ctx.js";

export async function run_mid_write_restart(ctx: LiveRunCtx): Promise<LiveRunOutput> {
  const { events, notes, invalid_reasons, env, cwd, timeout, effect_grace_ms, command, args, stamp, sid, c1, i1 } = ctx;
  const WRITE_PROBE_PROMPT_MS = ctx.write_probe_prompt_ms;
  const first_path = `asa-mid-write-${stamp}.txt`;
  const first_content = `asa-mid-write-${stamp}`;
  const write_prompt_timeout = Math.max(timeout, WRITE_PROBE_PROMPT_MS);
  notes.push(
    `mid-write-restart: interrupt after session/request_permission, BEFORE allow/deny/cancel (not post-allow in_progress)`,
  );
  notes.push(
    `mid-write-restart gen1: Write ${first_path}; prompt timeout_ms=${write_prompt_timeout}; hold mode — no permission answer`,
  );
  const prompt_text = `Write ${first_path} with exactly: ${first_content}`;
  const prompt_promise = i1.rpc.request(build_session_prompt(4, sid, prompt_text), write_prompt_timeout);
  let prompt_settled = false;
  void prompt_promise.then(() => { prompt_settled = true; });
  // Wait until permission arrives, the prompt returns (e.g. agent never called tools), or window ends.
  const wait_deadline = Date.now() + Math.min(60_000, write_prompt_timeout);
  while (Date.now() < wait_deadline && i1.rpc.permission_requests === 0 && !prompt_settled) {
    await sleep(50);
  }
  const held = events.filter((e) => e.type === "permission_request").at(-1);
  if (!held || held.type !== "permission_request") {
    const reason =
      "mid-write-restart: no session/request_permission observed before interrupt window (never reached interrupt point)";
    invalid_reasons.push(reason);
    notes.push(`RUN INVALID: ${reason} — keep run dir for evidence; do not count toward live aggregation`);
    notes.push("mid-write-restart FAIL: no session/request_permission observed before interrupt window");
  } else {
    notes.push(
      `mid-write-restart: permission outstanding request_id=${held.requestId}` +
        (held.toolCallId ? ` toolCallId=${held.toolCallId}` : "") +
        ` tool=${held.toolName} — SIGTERM before allow/deny/cancel`,
    );
  }
  // Brief settle so ASA_FAKE_WRITE_WITHOUT_PERMISSION can land before kill.
  await sleep(150);
  await stop(c1);
  // Clear gen1 session/prompt timer — otherwise the 180s write-probe wait keeps the process alive.
  const cancelled = i1.rpc.cancel_pending("SIGTERM_mid_write_permission_outstanding");
  notes.push(
    `mid-write-restart: cleared ${cancelled} pending client request timer(s) after SIGTERM (no leftover session/prompt wait)`,
  );
  void prompt_promise;
  events.push(observe_event({
    type: "session_update",
    sessionId: sid,
    update: {
      kind: "prompt_result",
      prompt: "mid_write_interrupted_before_allow",
      response: { abandoned: true, reason: "SIGTERM_while_permission_outstanding" },
      effect_path: first_path,
      effect_content: first_content,
      prompt_timeout_ms: write_prompt_timeout,
    },
  }));

  notes.push(
    "AUTH-01 RuntimeRestart: terminated generation 1 with SIGTERM while permission outstanding; spawning generation 2.",
  );
  events.push(observe_event({
    type: "runtime_restart",
    sessionId: sid,
    reason: "SIGTERM_mid_write_permission_outstanding",
  }));

  const c2 = await spawn_live(command, args, env);
  const i2 = await initialize(c2, events, notes, timeout, "allow", cwd);
  i2.rpc.set_session(sid);
  let restored = false;
  let gen2_version_ok = true;
  if (i2.result) {
    const ver2 = agent_info_version(i2.result);
    if (ctx.package_version_observed === undefined && ver2 !== undefined) {
      ctx.package_version_observed = ver2;
    }
    if (ver2 !== PINNED) {
      gen2_version_ok = false;
      invalid_reasons.push(
        `generation 2 agentInfo.version=${ver2 ?? "missing"} != pinned ${PINNED}`,
      );
      notes.push(
        `RUN INVALID: generation 2 agentInfo.version=${ver2 ?? "missing"} != pinned ${PINNED} — no gen2 load/disk probe`,
      );
    }
  } else {
    gen2_version_ok = false;
    invalid_reasons.push("generation 2 initialize returned no result");
    notes.push("RUN INVALID: generation 2 initialize returned no result — no gen2 load/disk probe");
  }

  if (i2.result && gen2_version_ok) {
    const events_before_load = events.length;
    const loaded = await i2.rpc.request(build_session_load(6, sid, cwd), timeout);
    restored = "result" in loaded;
    events.push(observe_event({
      type: "session_update",
      sessionId: sid,
      update: { kind: "session_load", cwd, response: loaded },
    }));
    notes.push(
      `mid-write-restart gen2: session/load restored=${restored}; waiting briefly for post-load report about interrupted tool call (no forced second write)`,
    );
    // Allow post-load tool_call_update (e.g. failed) to arrive after the load response.
    // Ignore session/load replay-period updates (same rule as history judgment).
    const load_event_idx = events.findIndex(
      (e, i) => i >= events_before_load && e.type === "session_update" && e.update.kind === "session_load",
    );
    const wait_from = load_event_idx >= 0 ? load_event_idx + 1 : events.length;
    const post_load_grace = Math.min(effect_grace_ms, 2000);
    const post_deadline = Date.now() + post_load_grace;
    while (Date.now() < post_deadline) {
      // Same tool-call cut as the notes/history (raw_update.sessionUpdate): an initial
      // tool_call carrying ACP category kind "edit" still counts as a post-load report.
      const post = events.slice(wait_from).filter((e) => {
        if (e.type !== "session_update") return false;
        const status = String(e.update.status ?? "");
        return is_tool_call_session_update(e.update) && (status === "failed" || status === "completed");
      });
      if (post.length > 0) break;
      await sleep(50);
    }
    // Align with history judgment: session/load replay-period updates are not post-load agent reports.
    const load_idx = events.findIndex(
      (e, i) => i >= events_before_load && e.type === "session_update" && e.update.kind === "session_load",
    );
    const post_load_start = load_idx >= 0 ? load_idx + 1 : events_before_load;
    const replay_reports = events.slice(events_before_load, post_load_start).filter((e) => {
      if (e.type !== "session_update") return false;
      return is_tool_call_session_update(e.update);
    });
    const post_reports = events.slice(post_load_start).filter((e) => {
      if (e.type !== "session_update") return false;
      return is_tool_call_session_update(e.update);
    });
    if (replay_reports.length > 0) {
      notes.push(
        `mid-write-restart gen2: session/load replay-period tool_call updates=${replay_reports.length}` +
          ` statuses=${replay_reports.map((e) => e.type === "session_update" ? String(e.update.status ?? "") : "").join(",")} (replay — not post-load agent reports)`,
      );
    }
    notes.push(
      `mid-write-restart gen2: post-load tool_call reports=${post_reports.length}` +
        (post_reports.length
          ? ` statuses=${post_reports.map((e) => e.type === "session_update" ? String(e.update.status ?? "") : "").join(",")}`
          : " (silent — nothing new about interrupted call)"),
    );

    // Disk probe for the interrupted file only — do NOT force a second gen2 write.
    await wait_for_write_effect(first_path, events, notes, {
      grace_ms: Math.min(effect_grace_ms, 1500),
      label: "mid-write-restart:" + first_path,
      expected: first_content,
      sessionId: sid,
      cwd,
      since_index: events_before_load,
    });
    try {
      const abs = path.resolve(cwd, first_path);
      const present = fs.existsSync(abs);
      notes.push(
        present
          ? `mid-write-restart C-signal: interrupted file ${first_path} PRESENT after restart without grant — defect / unexpected effect`
          : `mid-write-restart C-signal: interrupted file ${first_path} absent after restart (expected when agent waited for permission)`,
      );
    } catch (e) {
      notes.push(`mid-write-restart C-signal: fs check failed: ${String(e)}`);
    }
  }

  await stop(c2);
  events.push(observe_event({
    type: "session_closed",
    sessionId: sid,
    reason: restored ? "live_mid_write_restart_ok" : "live_mid_write_restart_incomplete",
  }));
  notes.push(
    `client fs: write_text_file performed=${i1.rpc.fs_write_performed + i2.rpc.fs_write_performed} read_text_file served=${i1.rpc.fs_read_served + i2.rpc.fs_read_served}`,
  );
  const history = live_history_from_peer_events(events);
  return { events, history, package_version_observed: ctx.package_version_observed, invalid_reasons };
}
