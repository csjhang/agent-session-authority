/**
 * PR-10d: wait_for_write_effect tool-call cut must match history —
 * is_tool_call_session_update (raw_update.sessionUpdate), not update.kind.
 * Positive case: kind="edit" + sessionUpdate="tool_call" must count as completed.
 * Calls the real wait_for_write_effect; does not reimplement the predicate.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { wait_for_write_effect } from "../src/effect_wait.js";
import type { AcpPeerEvent } from "../src/mock_peer.js";

function tmp_dir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `asa-pr10d-effect-wait-${label}-`));
}

describe("effect_wait tool-call cut (is_tool_call_session_update)", () => {
  it(
    "positive: kind=edit + raw_update.sessionUpdate=tool_call + completed + title basename → tool_call_completed true",
    async () => {
      const cwd = tmp_dir("positive");
      const target = "asa-target.txt";
      // File must not exist; small grace so the wait ends quickly.
      expect(fs.existsSync(path.join(cwd, target))).toBe(false);

      const events: AcpPeerEvent[] = [
        {
          type: "session_update",
          sessionId: "s-pr10d",
          update: {
            kind: "edit",
            status: "completed",
            title: `Write ${target}`,
            raw_update: { sessionUpdate: "tool_call", title: `Write ${target}`, status: "completed" },
          },
        },
      ];
      const notes: string[] = [];
      const out = await wait_for_write_effect(target, events, notes, {
        grace_ms: 50,
        poll_ms: 10,
        since_index: 0,
        cwd,
      });
      expect(out.present).toBe(false);
      expect(out.tool_call_completed).toBe(true);
    },
    10_000,
  );

  it(
    "negative: kind=edit + raw_update.sessionUpdate=agent_message_chunk + completed + title basename → tool_call_completed false",
    async () => {
      const cwd = tmp_dir("negative");
      const target = "asa-target.txt";
      expect(fs.existsSync(path.join(cwd, target))).toBe(false);

      const events: AcpPeerEvent[] = [
        {
          type: "session_update",
          sessionId: "s-pr10d",
          update: {
            kind: "edit",
            status: "completed",
            title: `Write ${target}`,
            raw_update: {
              sessionUpdate: "agent_message_chunk",
              title: `Write ${target}`,
              status: "completed",
            },
          },
        },
      ];
      const notes: string[] = [];
      const out = await wait_for_write_effect(target, events, notes, {
        grace_ms: 50,
        poll_ms: 10,
        since_index: 0,
        cwd,
      });
      expect(out.present).toBe(false);
      expect(out.tool_call_completed).toBe(false);
    },
    10_000,
  );
});
