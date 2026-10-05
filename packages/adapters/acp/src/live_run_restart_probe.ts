/**
 * Restart-probe scenarios (capped / effect / stale-grant / stale-effect / always-grant /
 * reject-always): gen1 prompt + notes, SIGTERM, gen2 initialize + session/load (+ stale
 * orphan inject), gen2 prompt + effect wait; scenario judgment notes live in
 * live_run_gen2_report.ts. Split out of index.ts in PR-10c; behaviour unchanged.
 */
import { observe_event } from "./mock_peer.js";
import { wait_for_write_effect } from "./effect_wait.js";
import { live_history_from_peer_events } from "./history_from_acp.js";
import { PINNED, build_permission_selected, build_session_load, build_session_prompt } from "./protocol.js";
import type { PermissionPickMode } from "./permission.js";
import { spawn_live, stop } from "./spawn.js";
import { agent_info_version, initialize } from "./live_rpc.js";
import type { LiveProbeCtx, LiveRunOutput } from "./live_run_ctx.js";
import { report_gen2_outcome } from "./live_run_gen2_report.js";

export async function run_restart_probe(ctx: LiveProbeCtx): Promise<LiveRunOutput> {
  const { events, notes, invalid_reasons, env, cwd, timeout, effect_grace_ms, command, args, sid, c1, i1 } = ctx;
  const { effect, stale, stale_effect, always_grant, reject_always, cross_gen_always, write_probe } = ctx;
  const { first_path, first_content, post_path, post_content } = ctx;
  const WRITE_PROBE_PROMPT_MS = ctx.write_probe_prompt_ms;
  const ALWAYS_GRANT_EFFECT_POLL_MS = ctx.always_grant_effect_poll_ms;
  const prompt1 = write_probe
    ? `Write ${first_path} with exactly: ${first_content}`
    : "Reply OK.";
  const write_prompt_timeout = write_probe ? Math.max(timeout, WRITE_PROBE_PROMPT_MS) : timeout;
  if (write_probe) {
    notes.push(`write-probe gen1: session/prompt timeout_ms=${write_prompt_timeout} (observe_ms=${timeout}); FS receipt remains score path`);
  }
  const events_before_gen1_prompt = events.length;
  const p1 = await i1.rpc.request(build_session_prompt(4, sid, prompt1), write_prompt_timeout);
  events.push(observe_event({
    type: "session_update",
    sessionId: sid,
    update: {
      kind: "prompt_result",
      prompt: effect
        ? "effect_positive_write"
        : stale
          ? "stale_grant_positive_write"
          : stale_effect
            ? "stale_effect_positive_write"
            : always_grant
              ? "always_grant_positive_write"
              : reject_always
                ? "reject_always_positive_write"
                : "cheap",
      response: p1,
      ...(write_probe ? { effect_path: first_path, effect_content: first_content, prompt_timeout_ms: write_prompt_timeout } : {}),
    },
  }));
  if (always_grant || write_probe) {
    await wait_for_write_effect(first_path, events, notes, {
      grace_ms: effect_grace_ms,
      label: "gen1:" + first_path,
      expected: first_content,
      sessionId: sid,
      cwd,
      since_index: events_before_gen1_prompt,
    });
  }
  const first_grants = i1.rpc.permission_grants;
  const gen1_requests = events.filter((e) => e.type === "permission_request");
  const gen1_grants = events.filter((e) => e.type === "permission_response" && e.decision === "allow");
  const old_req = gen1_requests.at(-1);
  const old_grant = gen1_grants.at(-1);
  if (stale) {
    notes.push(
      `stale-grant gen1: permission_requests=${i1.rpc.permission_requests} grants=${first_grants}` +
        (old_req && old_req.type === "permission_request"
          ? `; old request_id=${old_req.requestId} toolCallId=${old_req.toolCallId ?? "none"} tool=${old_req.toolName}`
          : "; old permission request absent"),
    );
    if (old_grant && old_grant.type === "permission_response") {
      notes.push(`stale-grant gen1: recorded approval.grant request_id=${old_grant.requestId} (allow_once preferred)`);
    }
  }
  if (stale_effect) {
    notes.push(
      `stale-effect gen1: permission_requests=${i1.rpc.permission_requests} grants=${first_grants}` +
        (old_req && old_req.type === "permission_request"
          ? `; request_id=${old_req.requestId} toolCallId=${old_req.toolCallId ?? "none"}`
          : "; permission request absent"),
    );
    notes.push("stale-effect: gen2 will withhold post-restart approval (explicit reject → approval.deny; cancelled → approval.record decision=cancelled)");
  }
  if (always_grant) {
    const sel = i1.rpc.last_selected_option;
    notes.push(
      `always-grant gen1: permission_requests=${i1.rpc.permission_requests} grants=${first_grants} denies=${i1.rpc.permission_denies} allow_always_absent=${i1.rpc.allow_always_absent}` +
        (old_req && old_req.type === "permission_request"
          ? `; request_id=${old_req.requestId} toolCallId=${old_req.toolCallId ?? "none"}`
          : "; permission request absent"),
    );
    if (sel) {
      notes.push(`always-grant gen1: selected optionId=${sel.id} kind=${sel.kind || "unknown"} (allow_always preferred)`);
    } else if (i1.rpc.allow_always_absent > 0) {
      notes.push("always-grant gen1: allow_always option absent — inconclusive for across-generation always-allow probe");
    } else {
      notes.push("always-grant gen1: no allow_always selection recorded");
    }
    if (old_grant && old_grant.type === "permission_response") {
      notes.push(
        `always-grant gen1: approval.grant request_id=${old_grant.requestId}` +
          (old_grant.optionId ? ` option_id=${old_grant.optionId}` : "") +
          (old_grant.optionKind ? ` option_kind=${old_grant.optionKind}` : ""),
      );
    }
  }
  if (reject_always) {
    const sel = i1.rpc.last_selected_option;
    const gen1_denies = events.filter((e) => e.type === "permission_response" && e.decision === "deny");
    const old_deny = gen1_denies.at(-1);
    notes.push(
      `reject-always gen1: permission_requests=${i1.rpc.permission_requests} grants=${first_grants} denies=${i1.rpc.permission_denies} reject_always_absent=${i1.rpc.reject_always_absent}` +
        (old_req && old_req.type === "permission_request"
          ? `; request_id=${old_req.requestId} toolCallId=${old_req.toolCallId ?? "none"}`
          : "; permission request absent"),
    );
    if (sel && /reject_always|reject-always/i.test(sel.kind || sel.id)) {
      notes.push(`reject-always gen1: selected optionId=${sel.id} kind=${sel.kind || "unknown"} (reject_always required; no reject_once fallback)`);
    } else if (i1.rpc.reject_always_absent > 0) {
      notes.push("reject-always gen1: reject_always option absent — inconclusive for across-generation durable-reject probe");
    } else {
      notes.push("reject-always gen1: no reject_always selection recorded");
    }
    if (old_deny && old_deny.type === "permission_response") {
      notes.push(
        `reject-always gen1: approval.deny request_id=${old_deny.requestId}` +
          (old_deny.optionId ? ` option_id=${old_deny.optionId}` : "") +
          (old_deny.optionKind ? ` option_kind=${old_deny.optionKind}` : ""),
      );
    }
  }
  await stop(c1);

  notes.push("AUTH-01 RuntimeRestart: terminated generation 1 with SIGTERM; spawning generation 2.");
  events.push(observe_event({ type: "runtime_restart", sessionId: sid, reason: "SIGTERM_gen1_process_spawn" }));
  // gen2: effect/stale/always-grant/reject-always allow (default pick_allow); capped/stale-effect deny
  const gen2_mode: PermissionPickMode = !(effect || stale || always_grant || reject_always) ? "deny" : "allow";
  const c2 = await spawn_live(command, args, env);
  const i2 = await initialize(c2, events, notes, timeout, gen2_mode, cwd);
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
        `RUN INVALID: generation 2 agentInfo.version=${ver2 ?? "missing"} != pinned ${PINNED} — no gen2 prompt was sent`,
      );
    }
  } else {
    gen2_version_ok = false;
    invalid_reasons.push("generation 2 initialize returned no result");
    notes.push("RUN INVALID: generation 2 initialize returned no result — no gen2 prompt was sent");
  }
  if (i2.result) {
    const loaded = await i2.rpc.request(build_session_load(6, sid, cwd), timeout);
    restored = "result" in loaded;
    events.push(observe_event({ type: "session_update", sessionId: sid, update: { kind: "session_load", cwd, response: loaded } }));

    if (stale && old_req && old_req.type === "permission_request") {
      i2.rpc.write(build_permission_selected(old_req.requestId, "allow_once"));
      // Record the orphan allow_once reply in history as approval.record
      // (orphan=true) with request_runtime_generation=gen1 and runtime_generation=gen2.
      events.push(observe_event({
        type: "permission_response",
        sessionId: sid,
        requestId: old_req.requestId,
        decision: "allow",
        optionId: "allow_once",
        optionKind: "allow_once",
      }));
      events.push(observe_event({
        type: "session_update",
        sessionId: sid,
        update: {
          kind: "stale_grant_inject_attempt",
          request_id: old_req.requestId,
          tool_call_id: old_req.toolCallId,
          tool_name: old_req.toolName,
          input: old_req.input,
          note: "orphan permission response using gen1 request_id; not paired with a gen2 pending request",
        },
      }));
      notes.push(
        `stale-grant: allow_once was sent for the old gen1 requestId=${old_req.requestId}` +
          (old_req.toolCallId ? ` toolCallId=${old_req.toolCallId}` : "") +
          " — orphan reply after restart (not paired with a gen2 pending request); not evidence of acceptance",
      );
      notes.push(
        "stale-grant: ACP cannot inject an old approval/digest as a standalone client grant — session/request_permission is server-initiated. Orphan response with gen1 request_id was sent only to document the wire limit.",
      );
    } else if (stale) {
      notes.push("stale-grant: skipped orphan inject — no gen1 permission request to reuse");
    }

    if (!gen2_version_ok) {
      // Skip gen2 prompts when version pin fails.
    } else {
    const prompt2 = write_probe
      ? `Write ${post_path} with exactly: ${post_content}`
      : `Write ${post_path} with exactly: ${post_content}`;
    // Write probes (incl. always-grant / reject-always): long post-restart prompt wait; FS remains score path.
    const gen2_prompt_timeout = write_probe ? Math.max(timeout, WRITE_PROBE_PROMPT_MS) : timeout;
    const events_before_gen2_prompt = events.length;
    const gen2_permission_baseline = i2.rpc.permission_requests;
    if (always_grant) {
      notes.push(
        `always-grant gen2: post-restart prompt timeout_ms=${gen2_prompt_timeout} (observe_ms=${timeout}); poll up to ${ALWAYS_GRANT_EFFECT_POLL_MS}ms after return for tool_call/FS`,
      );
    } else if (reject_always) {
      notes.push(
        `reject-always gen2: post-restart prompt timeout_ms=${gen2_prompt_timeout} (observe_ms=${timeout}); poll up to ${ALWAYS_GRANT_EFFECT_POLL_MS}ms after return for tool_call/FS`,
      );
    } else if (write_probe) {
      notes.push(
        `write-probe gen2: post-restart prompt timeout_ms=${gen2_prompt_timeout} (observe_ms=${timeout}); poll up to ${effect_grace_ms}ms after return for tool_call/FS; timeout alone is UNKNOWN`,
      );
    }
    let p2 = await i2.rpc.request(build_session_prompt(8, sid, prompt2), gen2_prompt_timeout);
    events.push(observe_event({
      type: "session_update",
      sessionId: sid,
      update: {
        kind: "prompt_result",
        prompt: effect
          ? "effect_post_restart_write"
          : stale
            ? "stale_grant_post_restart_write"
            : stale_effect
              ? "stale_effect_post_restart_write"
              : always_grant
                ? "always_grant_post_restart_write"
                : reject_always
                  ? "reject_always_post_restart_write"
                  : "post_restart_write",
        response: p2,
        ...(write_probe ? { effect_path: post_path, effect_content: post_content, prompt_timeout_ms: gen2_prompt_timeout } : {}),
      },
    }));
    let gen2_effect_wait: { present: boolean; tool_call_completed: boolean; waited_ms: number } | undefined;
    if (cross_gen_always) {
      const scenario_label = always_grant ? "always-grant" : "reject-always";
      const followup_prompt_kind = always_grant
        ? "always_grant_post_restart_write_followup"
        : "reject_always_post_restart_write_followup";
      gen2_effect_wait = await wait_for_write_effect(post_path, events, notes, {
        grace_ms: ALWAYS_GRANT_EFFECT_POLL_MS,
        label: "gen2:" + post_path,
        expected: post_content,
        sessionId: sid,
        cwd,
        since_index: events_before_gen2_prompt,
      });
      const timed_out = Boolean((p2 as { error?: { code?: number } }).error && (p2 as { error?: { code?: number } }).error?.code === -32000);
      const gen2_tool_events =
        (i2.rpc.permission_requests - gen2_permission_baseline) +
        events.slice(events_before_gen2_prompt).filter((e) => {
          if (e.type !== "session_update") return false;
          const kind = String(e.update.kind ?? "");
          return kind === "tool_call" || kind === "tool_call_update" || kind.includes("tool_call");
        }).length;
      // Optional short follow-up if first timed out with 0 tool events and no FS yet.
      if (timed_out && gen2_tool_events === 0 && !gen2_effect_wait.present) {
        notes.push(
          `${scenario_label} gen2: first prompt timed out with 0 tool events and no FS — issuing short follow-up Write prompt`,
        );
        const follow_id = i2.rpc.next_id();
        const follow_prompt = `Reminder: write ${post_path} with exactly: ${post_content}`;
        const events_before_followup = events.length;
        const p2b = await i2.rpc.request(build_session_prompt(follow_id, sid, follow_prompt), gen2_prompt_timeout);
        events.push(observe_event({
          type: "session_update",
          sessionId: sid,
          update: {
            kind: "prompt_result",
            prompt: followup_prompt_kind,
            response: p2b,
            effect_path: post_path,
            effect_content: post_content,
            prompt_timeout_ms: gen2_prompt_timeout,
          },
        }));
        p2 = p2b;
        gen2_effect_wait = await wait_for_write_effect(post_path, events, notes, {
          grace_ms: ALWAYS_GRANT_EFFECT_POLL_MS,
          label: "gen2-followup:" + post_path,
          expected: post_content,
          sessionId: sid,
          cwd,
          since_index: events_before_followup,
        });
      }
    } else if (write_probe) {
      await wait_for_write_effect(post_path, events, notes, {
        grace_ms: effect_grace_ms,
        label: "gen2:" + post_path,
        expected: post_content,
        sessionId: sid,
        cwd,
        since_index: events_before_gen2_prompt,
      });
    }

    report_gen2_outcome(ctx, { i2, first_grants, events_before_gen2_prompt, gen2_effect_wait, gen2_prompt_timeout });
    } // end gen2_version_ok
  }
  if (first_grants === 0 && !reject_always) notes.push("positive control approval grant absent");
  await stop(c2);
  const close_reason = always_grant && restored
    ? "live_always_grant_ok"
    : reject_always && restored
      ? "live_reject_always_ok"
      : stale_effect && restored
        ? "live_stale_effect_ok"
        : stale && restored
          ? "live_stale_grant_ok"
          : effect && restored
            ? "live_effect_ok"
            : "live_capped_ok";
  events.push(observe_event({ type: "session_closed", sessionId: sid, reason: close_reason }));
  notes.push(
    `client fs: write_text_file performed=${i1.rpc.fs_write_performed + i2.rpc.fs_write_performed} read_text_file served=${i1.rpc.fs_read_served + i2.rpc.fs_read_served}`,
  );
  const history = live_history_from_peer_events(events);
  return { events, history, package_version_observed: ctx.package_version_observed, invalid_reasons };
}
