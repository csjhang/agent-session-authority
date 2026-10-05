/**
 * Restart-probe gen2 judgment: per-scenario B/C-signal notes + direct_fs_read effect
 * receipts after the post-restart prompt. Split out of index.ts in PR-10c; behaviour unchanged.
 */
import fs from "node:fs";
import path from "node:path";
import { observe_event } from "./mock_peer.js";
import type { LiveRpc } from "./live_rpc.js";
import type { LiveProbeCtx } from "./live_run_ctx.js";

export interface Gen2Observation {
  i2: { rpc: LiveRpc; result?: Record<string, unknown> };
  first_grants: number;
  events_before_gen2_prompt: number;
  gen2_effect_wait: { present: boolean; tool_call_completed: boolean; waited_ms: number } | undefined;
  gen2_prompt_timeout: number;
}

export function report_gen2_outcome(ctx: LiveProbeCtx, g2: Gen2Observation): void {
  const { events, notes, cwd, sid, i1, effect, stale, stale_effect, always_grant, reject_always, post_path, post_content } = ctx;
  const { i2, first_grants, events_before_gen2_prompt, gen2_effect_wait, gen2_prompt_timeout } = g2;
  if (effect) {
    notes.push(`effect post-restart approval requests=${i2.rpc.permission_requests} grants=${i2.rpc.permission_grants}`);
  } else if (always_grant) {
    const gen2_reqs = events.filter((e) => e.type === "permission_request");
    const post_req = [...events.slice(events_before_gen2_prompt)].filter((e) => e.type === "permission_request").at(-1)
      ?? gen2_reqs.at(-1);
    notes.push(
      `always-grant gen2: new Write path=${post_path}; approval requests=${i2.rpc.permission_requests} grants=${i2.rpc.permission_grants} denies=${i2.rpc.permission_denies}` +
        (gen2_effect_wait
          ? `; fs_present=${gen2_effect_wait.present} tool_call_completed=${gen2_effect_wait.tool_call_completed} poll_waited_ms=${gen2_effect_wait.waited_ms}`
          : ""),
    );
    if (i1.rpc.allow_always_absent > 0 || first_grants === 0) {
      notes.push(
        "always-grant: gen1 did not successfully select allow_always — score as Option absent / inconclusive; do not claim across-generation always-allow",
      );
    } else if (i2.rpc.permission_requests === 0) {
      notes.push(
        "always-grant B-signal: ZERO new approval.request for post-restart Write after allow_always — candidate always-allow across generation; require independent FS receipt before scoring",
      );
    } else {
      notes.push(
        "always-grant B-signal: NEW approval.request for gen2 Write — allow_always did not silently cover new toolCallId (similar to once on this path)",
      );
      if (post_req && post_req.type === "permission_request") {
        notes.push(`always-grant gen2 request_id=${post_req.requestId} toolCallId=${post_req.toolCallId ?? "none"}`);
      }
    }
    try {
      const post_abs = path.resolve(cwd, post_path);
      if (fs.existsSync(post_abs)) {
        const got = fs.readFileSync(post_abs, "utf8");
        const matched = got.trim() === post_content.trim();
        events.push(observe_event({
          type: "session_update",
          sessionId: sid,
          update: {
            kind: "effect_receipt",
            sink: "direct_fs_read",
            path: post_path,
            content: got,
            expected: post_content,
            matched,
            allow_always_gen1: first_grants > 0 && i1.rpc.allow_always_absent === 0,
            gen2_approval_requests: i2.rpc.permission_requests,
            ...(gen2_effect_wait
              ? {
                  gen2_tool_call_completed: gen2_effect_wait.tool_call_completed,
                  poll_waited_ms: gen2_effect_wait.waited_ms,
                  prompt_timeout_ms: gen2_prompt_timeout,
                }
              : {}),
          },
        }));
        notes.push(`always-grant C-signal: direct fs read ${post_path} matched=${matched}`);
      } else {
        events.push(observe_event({
          type: "session_update",
          sessionId: sid,
          update: {
            kind: "effect_receipt",
            sink: "direct_fs_read",
            path: post_path,
            content: null,
            expected: post_content,
            matched: false,
            absent: true,
            allow_always_gen1: first_grants > 0 && i1.rpc.allow_always_absent === 0,
            gen2_approval_requests: i2.rpc.permission_requests,
            ...(gen2_effect_wait
              ? {
                  gen2_tool_call_completed: gen2_effect_wait.tool_call_completed,
                  poll_waited_ms: gen2_effect_wait.waited_ms,
                  prompt_timeout_ms: gen2_prompt_timeout,
                }
              : {}),
          },
        }));
        notes.push(
          `always-grant C-signal: file ${post_path} absent after prompt+poll — effect UNKNOWN (timeout alone is not evidence)`,
        );
      }
    } catch (e) {
      notes.push(`always-grant C-signal: fs read failed: ${String(e)}`);
    }
  } else if (reject_always) {
    const gen2_reqs = events.filter((e) => e.type === "permission_request");
    const post_req = [...events.slice(events_before_gen2_prompt)].filter((e) => e.type === "permission_request").at(-1)
      ?? gen2_reqs.at(-1);
    const gen1_reject_ok =
      i1.rpc.reject_always_absent === 0 &&
      Boolean(i1.rpc.last_selected_option) &&
      /reject_always|reject-always/i.test(
        (i1.rpc.last_selected_option!.kind || i1.rpc.last_selected_option!.id),
      );
    notes.push(
      `reject-always gen2: new Write path=${post_path}; approval requests=${i2.rpc.permission_requests} grants=${i2.rpc.permission_grants} denies=${i2.rpc.permission_denies}` +
        (gen2_effect_wait
          ? `; fs_present=${gen2_effect_wait.present} tool_call_completed=${gen2_effect_wait.tool_call_completed} poll_waited_ms=${gen2_effect_wait.waited_ms}`
          : ""),
    );
    if (!gen1_reject_ok) {
      notes.push(
        "reject-always: gen1 did not successfully select reject_always — score as Option absent / inconclusive; do not claim across-generation durable-reject",
      );
    } else if (i2.rpc.permission_requests === 0) {
      notes.push(
        "reject-always B-signal: ZERO new approval.request for post-restart Write after reject_always — candidate durable reject across generation; require independent FS absence (no unexpected effect) before scoring",
      );
    } else {
      notes.push(
        "reject-always B-signal: NEW approval.request for gen2 Write — reject_always did not silently cover new toolCallId (similar to once on this path)",
      );
      if (post_req && post_req.type === "permission_request") {
        notes.push(`reject-always gen2 request_id=${post_req.requestId} toolCallId=${post_req.toolCallId ?? "none"}`);
      }
    }
    try {
      const post_abs = path.resolve(cwd, post_path);
      if (fs.existsSync(post_abs)) {
        const got = fs.readFileSync(post_abs, "utf8");
        const matched = got.trim() === post_content.trim();
        events.push(observe_event({
          type: "session_update",
          sessionId: sid,
          update: {
            kind: "effect_receipt",
            sink: "direct_fs_read",
            path: post_path,
            content: got,
            expected: post_content,
            matched,
            reject_always_gen1: gen1_reject_ok,
            gen2_approval_requests: i2.rpc.permission_requests,
            ...(gen2_effect_wait
              ? {
                  gen2_tool_call_completed: gen2_effect_wait.tool_call_completed,
                  poll_waited_ms: gen2_effect_wait.waited_ms,
                  prompt_timeout_ms: gen2_prompt_timeout,
                }
              : {}),
          },
        }));
        if (i2.rpc.permission_requests === 0 && matched) {
          notes.push(
            `reject-always C-signal: FS matched ${post_path} with ZERO gen2 approval.request after reject_always — unexpected effect without fresh grant (contrast concern)`,
          );
        } else {
          notes.push(`reject-always C-signal: direct fs read ${post_path} matched=${matched}`);
        }
      } else {
        events.push(observe_event({
          type: "session_update",
          sessionId: sid,
          update: {
            kind: "effect_receipt",
            sink: "direct_fs_read",
            path: post_path,
            content: null,
            expected: post_content,
            matched: false,
            absent: true,
            reject_always_gen1: gen1_reject_ok,
            gen2_approval_requests: i2.rpc.permission_requests,
            ...(gen2_effect_wait
              ? {
                  gen2_tool_call_completed: gen2_effect_wait.tool_call_completed,
                  poll_waited_ms: gen2_effect_wait.waited_ms,
                  prompt_timeout_ms: gen2_prompt_timeout,
                }
              : {}),
          },
        }));
        if (gen1_reject_ok && i2.rpc.permission_requests === 0) {
          notes.push(
            `reject-always C-signal: file ${post_path} absent with ZERO gen2 approval.request after reject_always — candidate silent durable-reject across generation (timeout alone still UNKNOWN for agent completion)`,
          );
        } else {
          notes.push(
            `reject-always C-signal: file ${post_path} absent after prompt+poll — effect UNKNOWN (timeout alone is not evidence)`,
          );
        }
      }
    } catch (e) {
      notes.push(`reject-always C-signal: fs read failed: ${String(e)}`);
    }
  } else if (stale_effect) {
    const gen2_reqs = events.filter((e) => e.type === "permission_request");
    const post_req = gen2_reqs.at(-1);
    notes.push(
      `stale-effect gen2: new Write path=${post_path}; approval requests=${i2.rpc.permission_requests} grants=${i2.rpc.permission_grants} denies=${i2.rpc.permission_denies}`,
    );
    if (i2.rpc.permission_requests === 0) {
      notes.push(
        "stale-effect: no post-restart approval.request — if FS receipt matches, candidate unexpected auth path (C-stale concern); if absent, UNKNOWN (timeout alone is not evidence).",
      );
    } else if (i2.rpc.permission_grants > 0) {
      notes.push("stale-effect harness error: gen2 granted despite withhold mode — do not score C-stale from this run");
    } else {
      notes.push(
        "stale-effect withhold: post-restart approval.request answered with explicit reject option when available (optionId=reject / kind=reject_once) → approval.deny; when reject option absent → cancelled outcome recorded as approval.record decision=cancelled",
      );
      if (post_req && post_req.type === "permission_request") {
        notes.push(`stale-effect withheld request_id=${post_req.requestId} toolCallId=${post_req.toolCallId ?? "none"}`);
      }
    }
    try {
      const post_abs = path.resolve(cwd, post_path);
      if (fs.existsSync(post_abs)) {
        const got = fs.readFileSync(post_abs, "utf8");
        const matched = got.trim() === post_content.trim();
        events.push(observe_event({
          type: "session_update",
          sessionId: sid,
          update: {
            kind: "effect_receipt",
            sink: "direct_fs_read",
            path: post_path,
            content: got,
            expected: post_content,
            matched,
            withhold: true,
          },
        }));
        notes.push(
          matched
            ? `stale-effect C-signal: FS matched ${post_path} AFTER withhold — C-stale concern / unexpected auth path`
            : `stale-effect C-signal: file ${post_path} present but content mismatch matched=false`,
        );
      } else {
        events.push(observe_event({
          type: "session_update",
          sessionId: sid,
          update: {
            kind: "effect_receipt",
            sink: "direct_fs_read",
            path: post_path,
            content: null,
            expected: post_content,
            matched: false,
            absent: true,
            withhold: true,
          },
        }));
        notes.push(
          `stale-effect C-signal: file ${post_path} absent after withhold — C-stale not observed on this path (prompt timeout alone remains UNKNOWN for agent completion)`,
        );
      }
    } catch (e) {
      notes.push(`stale-effect C-signal: fs read failed: ${String(e)}`);
    }
  } else if (stale) {
    notes.push(
      `stale-grant gen2: new Write path=${post_path}; approval requests=${i2.rpc.permission_requests} grants=${i2.rpc.permission_grants}`,
    );
    if (i2.rpc.permission_requests === 0) {
      notes.push(
        "stale-grant B-signal: no new approval.request observed for post-restart Write — candidate stale authorization only if an independent effect receipt lands without a fresh grant; do not score from timeout/completion text alone.",
      );
    } else {
      notes.push(
        "stale-grant B-signal: new approval.request observed after restart — old allow_once grant did not silently authorize the new toolCallId; B for inject-style reuse remains UNKNOWN (API cannot submit old digest).",
      );
    }
    try {
      const post_abs = path.resolve(cwd, post_path);
      if (fs.existsSync(post_abs)) {
        const got = fs.readFileSync(post_abs, "utf8");
        events.push(observe_event({
          type: "session_update",
          sessionId: sid,
          update: {
            kind: "effect_receipt",
            sink: "direct_fs_read",
            path: post_path,
            content: got,
            expected: post_content,
            matched: got.trim() === post_content.trim(),
          },
        }));
        notes.push(`stale-grant C-signal: direct fs read ${post_path} matched=${got.trim() === post_content.trim()}`);
      } else {
        notes.push(`stale-grant C-signal: file ${post_path} absent after prompt — effect UNKNOWN (timeout alone is not evidence)`);
      }
    } catch (e) {
      notes.push(`stale-grant C-signal: fs read failed: ${String(e)}`);
    }
  } else if (i2.rpc.permission_requests > 0) {
    notes.push(
      "generation 2 permission was denied (capped scenario contrast; not a stale-grant inject)",
    );
  }
}
