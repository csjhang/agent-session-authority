/**
 * Leading history events must carry the real session id from session/new
 * (or session/load / session/resume when restoring), not the harness placeholder "live-session".
 * Fail-first on the pre-fix converter: header used the first peer sessionId (live-session).
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run_checkers } from "@asa/core";
import type { HistoryEvent } from "@asa/core";
import { live_history_from_peer_events } from "../src/index.js";
import type { AcpPeerEvent } from "../src/mock_peer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_LIVE_RUNS = path.resolve(here, "../../../../targets/claude-agent-acp/results/live-runs");

const auth01b = (history: unknown[]) =>
  run_checkers(history as HistoryEvent[], null, { test_basis: "research_profile" }).find(
    (f) => f.invariant === "AUTH-01b",
  )!;

function session_new_id(events: readonly AcpPeerEvent[]): string {
  for (const ev of events) {
    if (ev.type !== "session_update") continue;
    if (String(ev.update.kind ?? "") !== "session_new") continue;
    return ev.sessionId;
  }
  throw new Error("no session_new in peer events");
}

describe("leading session_id from session/new (not live-session)", () => {
  it("1. synthetic: header generation.observe + session.attach equal session/new id", () => {
    const real = "real-session-uuid";
    const events: AcpPeerEvent[] = [
      {
        type: "session_update",
        sessionId: "live-session",
        update: { kind: "initialize_result", result: { protocolVersion: 1 } },
        observed_at_ms: 1,
      },
      {
        type: "session_update",
        sessionId: real,
        update: {
          kind: "session_new",
          cwd: "/tmp/w",
          response: { jsonrpc: "2.0", id: 3, result: { sessionId: real } },
        },
        observed_at_ms: 2,
      },
    ];
    const history = live_history_from_peer_events(events);
    expect(history[0]!.op).toBe("generation.observe");
    expect(history[1]!.op).toBe("session.attach");
    expect(history[0]!.session_id).toBe(real);
    expect(history[1]!.session_id).toBe(real);
    expect(history[0]!.session_id).toBe(session_new_id(events));
    // initialize_result peer row still keeps its own recorded sessionId
    const init_obs = history.find(
      (e) => e.op === "session.attach" && e.attrs?.update_kind === "initialize_result",
    );
    expect(init_obs?.session_id).toBe("live-session");
  });

  it("2. restoring via session/load (no session/new): header uses load session id", () => {
    const restored = "restored-session-id";
    const events: AcpPeerEvent[] = [
      {
        type: "session_update",
        sessionId: "live-session",
        update: { kind: "initialize_result", result: {} },
        observed_at_ms: 1,
      },
      {
        type: "session_update",
        sessionId: restored,
        update: { kind: "session_load", cwd: "/tmp/w" },
        observed_at_ms: 2,
      },
    ];
    const history = live_history_from_peer_events(events);
    expect(history[0]!.session_id).toBe(restored);
    expect(history[1]!.session_id).toBe(restored);
  });

  it("3. restoring via session/resume (no session/new): header uses resume session id", () => {
    const resumed = "resumed-session-id";
    const events: AcpPeerEvent[] = [
      {
        type: "session_update",
        sessionId: "live-session",
        update: { kind: "initialize_result", result: {} },
        observed_at_ms: 1,
      },
      {
        type: "session_update",
        sessionId: resumed,
        update: { kind: "session_resume", cwd: "/tmp/w" },
        observed_at_ms: 2,
      },
    ];
    const history = live_history_from_peer_events(events);
    expect(history[0]!.session_id).toBe(resumed);
    expect(history[1]!.session_id).toBe(resumed);
  });

  it("4. committed live effect/r1 peer-events: header equals session/new; AUTH-01b supported", () => {
    const peer_path = path.join(REPO_LIVE_RUNS, "effect", "r1", "peer-events.jsonl");
    const events = fs
      .readFileSync(peer_path, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as AcpPeerEvent);
    const expect_sid = session_new_id(events);
    expect(expect_sid).not.toBe("live-session");
    const history = live_history_from_peer_events(events);
    expect(history[0]!.op).toBe("generation.observe");
    expect(history[1]!.op).toBe("session.attach");
    expect(history[0]!.session_id).toBe(expect_sid);
    expect(history[1]!.session_id).toBe(expect_sid);
    expect(auth01b(history).observed_result).toBe("supported");
  });
});
