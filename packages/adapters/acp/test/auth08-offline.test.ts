/**
 * Offline AUTH-08 probe matrix against fake-acp-agent.mjs (no API / no live cost).
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run_checkers, default_assessment } from "@asa/core";
import { collect_history } from "../src/index.js";
import {
  AUTH08_META,
  AUTH08_SCENARIOS,
  classify_bash_command,
  type Auth08Scenario,
} from "../src/auth08_scenarios.js";
import { content_matches_expected } from "../src/effect_wait.js";
import { live_history_from_peer_events } from "../src/history_from_acp.js";
import type { AcpPeerEvent } from "../src/mock_peer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fake_agent = path.join(here, "fixtures", "fake-acp-agent.mjs");

function tmp_dir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `asa-auth08-${label}-`));
}

function fake_env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ANTHROPIC_API_KEY: "offline-fake-agent-placeholder",
    ...extra,
  };
}

function auth08_opts(
  scenario: Auth08Scenario,
  cwd: string,
  extra_env: Record<string, string> = {},
) {
  const meta = AUTH08_META[scenario];
  return {
    mode: "live" as const,
    scenario,
    cwd,
    live_command: process.execPath,
    live_args: [fake_agent],
    env: fake_env({ ...meta.fake_env_base, ...extra_env }),
    effect_grace_ms: 3000,
    live_observe_ms: 5000,
    allow_weakened_permissions: true,
  };
}

describe("content_matches_expected (Bash newline / touch empty)", () => {
  it("allows trailing newline from echo", () => {
    expect(content_matches_expected("p5-ok\n", "p5-ok")).toBe(true);
    expect(content_matches_expected("p5-ok", "p5-ok\n")).toBe(true);
  });
  it("treats empty as match for touch", () => {
    expect(content_matches_expected("", "")).toBe(true);
  });
});

describe("classify_bash_command", () => {
  it("classifies touch as fs_command", () => {
    expect(classify_bash_command("touch asa-x.txt", "/tmp/asa-x.txt", "asa-x.txt")).toBe(
      "fs_command",
    );
  });
  it("classifies echo redirect as redirect", () => {
    expect(
      classify_bash_command("echo 'ok' > asa-x.txt", "/tmp/asa-x.txt", "asa-x.txt"),
    ).toBe("redirect");
  });
});

describe("AUTH-08 offline fake matrix", () => {
  for (const scenario of AUTH08_SCENARIOS) {
    it(
      `${scenario} asked (default ask) → probe attempt present; isolation in run stamp`,
      async () => {
        const cwd = tmp_dir(scenario.slice(0, 20));
        // Force ask for scenarios that would otherwise short-circuit
        const extra: Record<string, string> =
          scenario === "auth08-e9-client-fs-write"
            ? {}
            : { ASA_FAKE_NEVER_ASK: "0", ASA_FAKE_SETTINGS_SHORT_CIRCUIT: "0" };
        // For modes that auto-skip, still run; P1/P2 acceptEdits may skip ask by design
        const result = await collect_history(auth08_opts(scenario, cwd, extra));
        expect(result.run_valid, result.invalid_reasons.join("; ")).toBe(true);
        const attempts = result.history.filter((e) => e.op === "probe.bypass_attempt");
        expect(attempts.length).toBeGreaterThanOrEqual(1);
        expect(result.auth08_run_json?.isolation).toMatchObject({
          user_claude_bypassed: true,
          method: "CLAUDE_CONFIG_DIR+cwd_temp",
        });
        const modes = result.history.filter((e) => e.op === "probe.permission_mode");
        expect(modes.length).toBeGreaterThanOrEqual(1);
      },
      30000,
    );
  }

  it(
    "auth08-p1-bypassPermissions-write never-ask → bypass observation under empty disclosures",
    async () => {
      const cwd = tmp_dir("p1-never");
      const result = await collect_history(
        auth08_opts("auth08-p1-bypassPermissions-write", cwd, {
          ASA_FAKE_NEVER_ASK: "1",
        }),
      );
      expect(result.run_valid).toBe(true);
      const attempt = result.history.find((e) => e.op === "probe.bypass_attempt");
      expect(attempt?.attrs?.bypass_path_id).toBe("mode:bypassPermissions:Write");
      expect(attempt?.attrs?.tool_call_id).toBeTruthy();
      const assessment = default_assessment();
      assessment.auth08 = { enforcement_point: "client-permission" };
      assessment.target = "auth08-synthetic";
      const findings = run_checkers(result.history, null, assessment, {
        auth08_disclosures: {
          target: "auth08-synthetic",
          pinned_version: "0.0.0",
          entries: [],
        },
      });
      const auth08 = findings.find((f) => f.invariant === "AUTH-08");
      expect(auth08?.observed_result).toBe("violation");
    },
    30000,
  );

  it(
    "auth08-e9-client-fs-write → client:fs_write_text_file attempt + fs request peer",
    async () => {
      const cwd = tmp_dir("e9");
      const result = await collect_history(auth08_opts("auth08-e9-client-fs-write", cwd));
      expect(result.run_valid, result.invalid_reasons.join("; ")).toBe(true);
      const attempt = result.history.find((e) => e.op === "probe.bypass_attempt");
      expect(attempt?.attrs?.bypass_path_id).toBe("client:fs_write_text_file");
      const fs_req = result.events.filter(
        (e) =>
          e.type === "session_update" &&
          String((e as { update?: { kind?: string } }).update?.kind) ===
            "fs_write_text_file_request",
      );
      expect(fs_req.length).toBeGreaterThanOrEqual(1);
      expect(fs.existsSync(path.join(cwd, "asa-auth08-e9.txt"))).toBe(true);
    },
    30000,
  );

  it(
    "ASA_FAKE_LS_THEN_WRITE → attempt links to write tool_call_id, not ls (adapter strict link)",
    async () => {
      const cwd = tmp_dir("ls-write");
      const result = await collect_history(
        auth08_opts("auth08-p2-acceptEdits-write", cwd, {
          ASA_FAKE_LS_THEN_WRITE: "1",
          ASA_FAKE_NEVER_ASK: "1",
        }),
      );
      expect(result.run_valid, result.invalid_reasons.join("; ")).toBe(true);
      const attempt = result.history.find((e) => e.op === "probe.bypass_attempt");
      expect(attempt?.attrs?.tool_call_id).toBeTruthy();
      // Linked id must be the Write call (toolu_fake_2), not ls (toolu_fake_1)
      const tool_peers = result.events.filter(
        (e) =>
          e.type === "session_update" &&
          (e as { update?: { kind?: string } }).update?.kind === "tool_call",
      ) as Array<{ update: { toolCallId?: string; raw_update?: { rawInput?: { command?: string; file_path?: string } }; rawInput?: { command?: string; file_path?: string } } }>;
      const ls = tool_peers.find((e) => {
        const ri = e.update.raw_update?.rawInput ?? e.update.rawInput;
        return typeof ri?.command === "string" && ri.command.includes("ls");
      });
      const write = tool_peers.find((e) => {
        const ri = e.update.raw_update?.rawInput ?? e.update.rawInput;
        return typeof ri?.file_path === "string";
      });
      expect(ls?.update.toolCallId).toBeTruthy();
      expect(write?.update.toolCallId).toBeTruthy();
      expect(attempt?.attrs?.tool_call_id).toBe(write?.update.toolCallId);
      expect(attempt?.attrs?.tool_call_id).not.toBe(ls?.update.toolCallId);
    },
    30000,
  );

  it(
    "B: intent Bash redirect + two Writes → attempt has no bypass_path_id",
    async () => {
      const cwd = tmp_dir("dual-write");
      const result = await collect_history({
        mode: "live",
        scenario: "auth08-p2-acceptEdits-bash-redirect",
        cwd,
        live_command: process.execPath,
        live_args: [fake_agent],
        env: fake_env({
          ASA_FAKE_MODES: "1",
          ASA_FAKE_PERMISSION_MODE: "default",
          ASA_FAKE_DUAL_WRITE_UNLINKABLE: "1",
          ASA_FAKE_NEVER_ASK: "1",
          // Still set mode acceptEdits via scenario set_mode
        }),
        effect_grace_ms: 3000,
        live_observe_ms: 5000,
        allow_weakened_permissions: true,
      });
      expect(result.run_valid, result.invalid_reasons.join("; ")).toBe(true);
      const attempt = result.history.find((e) => e.op === "probe.bypass_attempt");
      expect(attempt?.attrs?.bypass_path_id).toBeUndefined();
      expect(attempt?.attrs?.tool_call_id).toBeUndefined();
    },
    30000,
  );

  it("P5 without default mode → run_valid false", async () => {
    const cwd = tmp_dir("p5-bad-mode");
    const result = await collect_history(
      auth08_opts("auth08-p5-default-bash-write", cwd, {
        ASA_FAKE_PERMISSION_MODE: "acceptEdits",
      }),
    );
    expect(result.run_valid).toBe(false);
    expect(result.invalid_reasons.some((r) => r.includes("currentModeId=default"))).toBe(
      true,
    );
  });

  it("safety: weakened live without flag refuses when not fake", async () => {
    const cwd = tmp_dir("safety");
    // Simulate non-fake by using a command path that is not node/fake
    const { assert_auth08_live_safety } = await import("../src/live_run_auth08.js");
    expect(() =>
      assert_auth08_live_safety("auth08-p1-bypassPermissions-write", cwd, {
        allow_weakened_permissions: false,
        live_command: "claude-agent-acp",
      }),
    ).toThrow(/allow-weakened-permissions/);
  });

  it("reconvert: peer without probe kinds → no probe history lines", () => {
    const events: AcpPeerEvent[] = [
      {
        type: "session_update",
        sessionId: "s1",
        update: { kind: "session_new", cwd: "/tmp/x" },
        observed_at_ms: 1,
      },
    ];
    const hist = live_history_from_peer_events(events);
    expect(hist.some((e) => e.op?.startsWith("probe."))).toBe(false);
  });
});
