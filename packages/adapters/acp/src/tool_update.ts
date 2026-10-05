/**
 * True when this observed session_update is an agent tool_call / tool_call_update.
 * Prefer raw_update.sessionUpdate (same field history AUTH-07 uses). Observed
 * update.kind is often the ACP tool category (e.g. "edit"), which must not exclude
 * the initial tool_call from mid-write note counts.
 */
export function is_tool_call_session_update(update: Record<string, unknown>): boolean {
  const raw = update.raw_update as Record<string, unknown> | undefined;
  const session_update = raw?.sessionUpdate;
  if (session_update === "tool_call" || session_update === "tool_call_update") return true;
  // Fallback when raw_update is absent (synthetic / older fixtures).
  const kind = String(update.kind ?? "");
  return kind === "tool_call" || kind === "tool_call_update" || kind.includes("tool_call");
}
