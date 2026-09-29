import fs from "node:fs";
import path from "node:path";
import { observe_event, type AcpPeerEvent } from "./mock_peer.js";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function infer_session_id(events: AcpPeerEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if ("sessionId" in e && typeof e.sessionId === "string" && e.sessionId) return e.sessionId;
  }
  return "unknown-session";
}

function tool_name_or_title(u: Record<string, unknown>): string {
  if (typeof u.toolName === "string" && u.toolName) return u.toolName;
  if (typeof u.title === "string" && u.title) return u.title;
  const raw = u.raw_update as Record<string, unknown> | undefined;
  if (raw) {
    if (typeof raw.title === "string" && raw.title) return raw.title;
    if (typeof raw.toolName === "string" && raw.toolName) return raw.toolName;
  }
  return "";
}

function is_completed_tool_call_for_basename(
  e: AcpPeerEvent,
  basename: string,
): boolean {
  if (e.type !== "session_update") return false;
  const u = e.update;
  const kind = String(u.kind ?? "");
  const status = String(u.status ?? u.toolCallStatus ?? "");
  const name = tool_name_or_title(u);
  if (!(kind === "tool_call" || kind === "tool_call_update" || kind.includes("tool_call"))) {
    return false;
  }
  if (!(status === "completed" || status === "Completed")) return false;
  if (!basename) return false;
  return name.includes(basename);
}

/**
 * Poll for an FS effect receipt and/or a recorded tool_call completed update.
 * Timeout alone is not effect proof.
 *
 * Wait ends only when the file is present (and matches expected when given),
 * or when grace expires. A matching tool_call completed is recorded but does
 * not end the wait early.
 *
 * Always appends a session_update kind=effect_receipt so acp_events_to_history
 * can emit effect.receipt with derived field_provenance (committed when the
 * observed file exists; unknown with reason when absent).
 */
export async function wait_for_write_effect(
  path_arg: string,
  events: AcpPeerEvent[],
  notes: string[],
  opts: {
    grace_ms?: number;
    poll_ms?: number;
    label?: string;
    sessionId?: string;
    expected?: string;
    /** Resolve relative paths against this directory (default process.cwd()). */
    cwd?: string;
    /**
     * Only events at this index or later count for tool_call_completed.
     * Default: events.length at call time (ignore prior buffer contents).
     */
    since_index?: number;
  } = {},
): Promise<{ present: boolean; tool_call_completed: boolean; waited_ms: number }> {
  const grace = opts.grace_ms ?? 20000;
  const poll = opts.poll_ms ?? 500;
  const label = opts.label ?? path_arg;
  const cwd = opts.cwd ?? process.cwd();
  const since_index = opts.since_index ?? events.length;
  const abs = path.resolve(cwd, path_arg);
  const basename = path.basename(path_arg);
  const started = Date.now();
  let present = false;
  let tool_call_completed = false;
  let content: string | undefined;
  let matched: boolean | undefined;

  while (Date.now() - started < grace) {
    tool_call_completed = events
      .slice(since_index)
      .some((e) => is_completed_tool_call_for_basename(e, basename));

    try {
      present = fs.existsSync(abs);
    } catch {
      present = false;
    }

    if (present) {
      if (opts.expected === undefined) break;
      try {
        content = fs.readFileSync(abs, "utf8");
        matched = content.trim() === opts.expected.trim();
        if (matched) break;
      } catch {
        matched = false;
      }
    }

    await sleep(poll);
  }

  // Final snapshot after loop (may have exited on grace).
  try {
    present = fs.existsSync(abs);
  } catch {
    present = false;
  }
  tool_call_completed = events
    .slice(since_index)
    .some((e) => is_completed_tool_call_for_basename(e, basename));
  if (present && opts.expected !== undefined) {
    try {
      content = fs.readFileSync(abs, "utf8");
      matched = content.trim() === opts.expected.trim();
    } catch {
      matched = false;
      content = undefined;
    }
  }

  const waited_ms = Date.now() - started;
  notes.push(
    `wait_for_write_effect(${label}): waited_ms=${waited_ms} present=${present} tool_call_completed=${tool_call_completed} grace_ms=${grace}`,
  );

  const sessionId = opts.sessionId ?? infer_session_id(events);
  events.push(
    observe_event({
      type: "session_update",
      sessionId,
      update: {
        kind: "effect_receipt",
        sink: "wait_for_write_effect",
        path: path_arg,
        present,
        absent: !present,
        tool_call_completed,
        waited_ms,
        grace_ms: grace,
        ...(opts.expected !== undefined ? { expected: opts.expected } : {}),
        ...(content !== undefined ? { content } : {}),
        ...(matched !== undefined ? { matched } : {}),
        ...(present ? {} : { withhold: true }),
      },
    }),
  );

  return { present, tool_call_completed, waited_ms };
}
