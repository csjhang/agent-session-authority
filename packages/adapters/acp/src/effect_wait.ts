import type { AcpPeerEvent } from "./mock_peer.js";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll for an FS effect receipt and/or a recorded tool_call completed update. Timeout alone is not effect proof. */
export async function wait_for_write_effect(
  path: string,
  events: AcpPeerEvent[],
  notes: string[],
  opts: { grace_ms?: number; poll_ms?: number; label?: string } = {},
): Promise<{ present: boolean; tool_call_completed: boolean; waited_ms: number }> {
  const grace = opts.grace_ms ?? 20000;
  const poll = opts.poll_ms ?? 500;
  const label = opts.label ?? path;
  const started = Date.now();
  let present = false;
  let tool_call_completed = false;
  while (Date.now() - started < grace) {
    try {
      const fs = await import("node:fs");
      present = fs.existsSync(path);
    } catch {
      present = false;
    }
    tool_call_completed = events.some((e) => {
      if (e.type !== "session_update") return false;
      const u = e.update;
      const kind = String(u.kind ?? "");
      const status = String(u.status ?? u.toolCallStatus ?? "");
      const name = String(u.toolName ?? u.title ?? "");
      // ACP session/update tool_call / tool_call_update with completed status
      return (kind === "tool_call" || kind === "tool_call_update" || kind.includes("tool_call")) &&
        (status === "completed" || status === "Completed") &&
        (name === "" || name.toLowerCase().includes("write") || path.includes(name));
    });
    if (present || tool_call_completed) break;
    await sleep(poll);
  }
  const waited_ms = Date.now() - started;
  notes.push(
    `wait_for_write_effect(${label}): waited_ms=${waited_ms} present=${present} tool_call_completed=${tool_call_completed} grace_ms=${grace}`,
  );
  return { present, tool_call_completed, waited_ms };
}
