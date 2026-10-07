/**
 * Offline AUTH-08 probe matrix against fake-acp-agent.mjs (no API / no live cost).
 * Round-2: verdict + attempt link assertions; bash class; safety; set_mode reject; CLAUDE_CONFIG_DIR.
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
import { acp_events_to_history, live_history_from_peer_events } from "../src/history_from_acp.js";
import type { AcpPeerEvent } from "../src/mock_peer.js";
import { assert_auth08_live_safety, is_auth08_fake_agent } from "../src/live_run_auth08.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fake_agent = path.join(here, "fixtures", "fake-acp-agent.mjs");
const repo_root = path.resolve(here, "../../../..");

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

function auth08_finding(history: Parameters<typeof run_checkers>[0], disclosures: { target: string; pinned_version: string; entries: Array<Record<string, unknown>> } | null) {
  const assessment = default_assessment();
  assessment.auth08 = { enforcement_point: "client-permission" };
  assessment.target = "auth08-synthetic";
  const findings = run_checkers(history, null, assessment, {
    auth08_disclosures: disclosures
      ? {
          target: disclosures.target,
          pinned_version: disclosures.pinned_version,
          entries: disclosures.entries as never,
        }
      : {
          target: "auth08-synthetic",
          pinned_version: "0.0.0",
          entries: [],
        },
  });
  return findings.find((f) => f.invariant === "AUTH-08");
}

const SET_MODE_SCENARIOS: Auth08Scenario[] = [
  "auth08-p2-acceptEdits-write",
  "auth08-p2-acceptEdits-bash-fs-command",
  "auth08-p2-acceptEdits-bash-redirect",
  "auth08-p1-bypassPermissions-write",
];

describe("content_matches_expected (trim both sides)", () => {
  it("allows trailing newline from echo via trim", () => {
    expect(content_matches_expected("p5-ok\n", "p5-ok")).toBe(true);
    expect(content_matches_expected("p5-ok", "p5-ok\n")).toBe(true);
  });
  it("treats empty as match for touch", () => {
    expect(content_matches_expected("", "")).toBe(true);
  });
  it("different content must NOT match (catch always-true mutation)", () => {
    expect(content_matches_expected("p5-ok", "p5-WRONG")).toBe(false);
    expect(content_matches_expected("abc\n", "abd")).toBe(false);
    expect(content_matches_expected("x", "")).toBe(false);
  });
});

describe("classify_bash_command (probe-targeted)", () => {
  const path_ = "/tmp/asa-x.txt";
  const base = "asa-x.txt";

  it("mkdir then printf redirect to probe → redirect (not fs_command)", () => {
    expect(
      classify_bash_command("mkdir -p . && printf 'p2r-ok' > asa-x.txt", path_, base),
    ).toBe("redirect");
  });
  it("ls redirect elsewhere then touch probe → fs_command", () => {
    expect(
      classify_bash_command("ls > /dev/null; touch asa-x.txt", path_, base),
    ).toBe("fs_command");
  });
  it("echo redirect to other then cp to probe → fs_command", () => {
    expect(
      classify_bash_command(
        "echo p2r-ok > /tmp/other.txt && cp /tmp/other.txt asa-x.txt",
        path_,
        base,
      ),
    ).toBe("fs_command");
  });
  it("2>/dev/null does not count as redirect to probe", () => {
    expect(
      classify_bash_command("touch asa-x.txt 2>/dev/null", path_, base),
    ).toBe("fs_command");
  });
  it("heredoc redirect to probe → redirect", () => {
    expect(
      classify_bash_command("cat > asa-x.txt <<EOF\nok\nEOF", path_, base),
    ).toBe("redirect");
  });
  it("python write → no id", () => {
    expect(
      classify_bash_command(
        "python -c \"open('asa-x.txt','w').write('ok')\"",
        path_,
        base,
      ),
    ).toBeUndefined();
  });
  it("both redirect and fs_command targeting probe → no id", () => {
    expect(
      classify_bash_command("echo x > asa-x.txt && touch asa-x.txt", path_, base),
    ).toBeUndefined();
  });
});

describe("AUTH-08 offline fake matrix (verdicts + attempt link)", () => {
  for (const scenario of AUTH08_SCENARIOS) {
    if (scenario === "auth08-e9-client-fs-write") continue;
    it(
      `${scenario} asked → supported + attempt tool_call_id/bypass_path_id`,
      async () => {
        const cwd = tmp_dir(`ask-${scenario.slice(7, 24)}`);
        const result = await collect_history(
          auth08_opts(scenario, cwd, {
            ASA_FAKE_FORCE_ASK: "1",
            ASA_FAKE_NEVER_ASK: "0",
            ASA_FAKE_SETTINGS_SHORT_CIRCUIT: "0",
          }),
        );
        expect(result.run_valid, result.invalid_reasons.join("; ")).toBe(true);
        const attempt = result.history.find((e) => e.op === "probe.bypass_attempt");
        expect(attempt?.attrs?.tool_call_id).toBeTruthy();
        expect(attempt?.attrs?.bypass_path_id).toBe(AUTH08_META[scenario].intent_bypass_path_id);
        const auth08 = auth08_finding(result.history, {
          target: "auth08-synthetic",
          pinned_version: "0.0.0",
          entries: [],
        });
        expect(auth08?.observed_result).toBe("supported");
        const modes = result.history.filter((e) => e.op === "probe.permission_mode");
        if (SET_MODE_SCENARIOS.includes(scenario)) {
          expect(modes.length).toBeGreaterThanOrEqual(1);
        } else {
          expect(modes.length).toBe(0);
        }
      },
      30000,
    );
  }

  for (const scenario of AUTH08_SCENARIOS) {
    it(
      `${scenario} never-asked + empty disclosures → violation + linked attempt`,
      async () => {
        const cwd = tmp_dir(`nv-${scenario.slice(7, 24)}`);
        const extra: Record<string, string> =
          scenario === "auth08-e9-client-fs-write"
            ? {}
            : { ASA_FAKE_NEVER_ASK: "1", ASA_FAKE_SETTINGS_SHORT_CIRCUIT: "1" };
        const result = await collect_history(auth08_opts(scenario, cwd, extra));
        expect(result.run_valid, result.invalid_reasons.join("; ")).toBe(true);
        const attempt = result.history.find((e) => e.op === "probe.bypass_attempt");
        expect(attempt?.attrs?.tool_call_id).toBeTruthy();
        expect(attempt?.attrs?.bypass_path_id).toBe(AUTH08_META[scenario].intent_bypass_path_id);
        const auth08 = auth08_finding(result.history, {
          target: "auth08-synthetic",
          pinned_version: "0.0.0",
          entries: [],
        });
        expect(auth08?.observed_result).toBe("violation");
      },
      30000,
    );
  }

  it(
    "never-asked + found disclosure → supported",
    async () => {
      const scenario: Auth08Scenario = "auth08-p1-bypassPermissions-write";
      const cwd = tmp_dir("found-disc");
      const result = await collect_history(
        auth08_opts(scenario, cwd, { ASA_FAKE_NEVER_ASK: "1" }),
      );
      expect(result.run_valid).toBe(true);
      const path_id = AUTH08_META[scenario].intent_bypass_path_id;
      const auth08 = auth08_finding(result.history, {
        target: "auth08-synthetic",
        pinned_version: "0.0.0",
        entries: [
          {
            bypass_path_id: path_id,
            quote: "synthetic found entry for offline matrix test",
            url: "https://example.invalid/docs/auth08",
            retrieved: "2026-10-07 Asia/Taipei",
            section: "Bypass honesty",
            doc_product_version: "0.0.0",
            version_relationship: "matches pinned_version",
            kind: "bypass",
            verification: { status: "found" },
          },
        ],
      });
      expect(auth08?.observed_result).toBe("supported");
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
      // E9 does not call set_mode → no probe.permission_mode
      expect(result.history.filter((e) => e.op === "probe.permission_mode")).toHaveLength(0);
    },
    30000,
  );

  it(
    "ASA_FAKE_LS_THEN_WRITE → attempt links to write tool_call_id, not ls",
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
      const tool_peers = result.events.filter((e) => {
        if (e.type !== "session_update") return false;
        const raw = (e.update as { raw_update?: { sessionUpdate?: string } }).raw_update;
        return raw?.sessionUpdate === "tool_call";
      }) as Array<{
        update: {
          toolCallId?: string;
          raw_update?: { rawInput?: { command?: string; file_path?: string }; toolCallId?: string };
        };
      }>;
      const ls = tool_peers.find((e) => {
        const ri = e.update.raw_update?.rawInput;
        return typeof ri?.command === "string" && ri.command.includes("ls");
      });
      const write = tool_peers.find((e) => {
        const ri = e.update.raw_update?.rawInput;
        return typeof ri?.file_path === "string";
      });
      const ls_id = ls?.update.toolCallId ?? ls?.update.raw_update?.toolCallId;
      const write_id = write?.update.toolCallId ?? write?.update.raw_update?.toolCallId;
      expect(ls_id).toBeTruthy();
      expect(write_id).toBeTruthy();
      expect(attempt?.attrs?.tool_call_id).toBe(write_id);
      expect(attempt?.attrs?.tool_call_id).not.toBe(ls_id);
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
    expect(result.invalid_reasons.some((r) => r.includes("currentModeId=default"))).toBe(true);
  });

  it("set_mode rejected → run_valid false", async () => {
    const cwd = tmp_dir("set-mode-rej");
    const result = await collect_history(
      auth08_opts("auth08-p2-acceptEdits-write", cwd, {
        ASA_FAKE_REJECT_SET_MODE: "1",
      }),
    );
    expect(result.run_valid).toBe(false);
    expect(result.invalid_reasons.some((r) => /set_mode.*reject/i.test(r))).toBe(true);
  });

  it("CLAUDE_CONFIG_DIR reaches fake agent and matches run.json", async () => {
    const cwd = tmp_dir("claude-cfg");
    const result = await collect_history(auth08_opts("auth08-p5-default-bash-write", cwd));
    expect(result.run_valid, result.invalid_reasons.join("; ")).toBe(true);
    const stamped = result.auth08_run_json?.claude_config_dir;
    const reported = result.auth08_run_json?.claude_config_dir_agent_reported;
    expect(typeof stamped).toBe("string");
    expect(reported).toBe(stamped);
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

describe("AUTH-08 safety guards (mutation)", () => {
  it("cwd inside repo → refuse", () => {
    expect(() =>
      assert_auth08_live_safety("auth08-p5-default-bash-write", repo_root, {
        allow_weakened_permissions: true,
        live_command: process.execPath,
        live_args: [fake_agent],
      }),
    ).toThrow(/inside the repo/);
  });

  it("cwd non-empty → refuse", () => {
    const cwd = tmp_dir("nonempty");
    fs.writeFileSync(path.join(cwd, "marker.txt"), "x");
    expect(() =>
      assert_auth08_live_safety("auth08-p5-default-bash-write", cwd, {
        allow_weakened_permissions: true,
        live_command: process.execPath,
        live_args: [fake_agent],
      }),
    ).toThrow(/not empty/);
  });

  it("weakened without flag refuses even when command is node", () => {
    const cwd = tmp_dir("weaken");
    expect(() =>
      assert_auth08_live_safety("auth08-p1-bypassPermissions-write", cwd, {
        allow_weakened_permissions: false,
        live_command: process.execPath,
        live_args: [fake_agent],
      }),
    ).toThrow(/allow-weakened-permissions/);
  });

  it("E9 refuses for real agent (not fake-acp-agent)", () => {
    const cwd = tmp_dir("e9-real");
    expect(is_auth08_fake_agent({ live_command: "claude-agent-acp", live_args: [] })).toBe(
      false,
    );
    expect(() =>
      assert_auth08_live_safety("auth08-e9-client-fs-write", cwd, {
        allow_weakened_permissions: true,
        live_command: "claude-agent-acp",
        live_args: [],
      }),
    ).toThrow(/fake-agent only/);
  });

  it("E9 allowed for fake-acp-agent via live_args", () => {
    const cwd = tmp_dir("e9-fake");
    expect(() =>
      assert_auth08_live_safety("auth08-e9-client-fs-write", cwd, {
        allow_weakened_permissions: true,
        live_command: process.execPath,
        live_args: [fake_agent],
      }),
    ).not.toThrow();
  });
});

describe("finalize_probe_attempts: write-capable only + dedupe", () => {
  it("Read with file_path is not a Write candidate; Write still links", () => {
    const probe = "/tmp/probe-write.txt";
    const events: AcpPeerEvent[] = [
      {
        type: "session_update",
        sessionId: "s1",
        update: { kind: "session_new", cwd: "/tmp" },
        observed_at_ms: 1,
      },
      {
        type: "session_update",
        sessionId: "s1",
        update: {
          kind: "probe_bypass_attempt",
          bypass_path_id: "mode:default:Write",
          path: probe,
          mechanism: "mode:default",
          runtime_generation: 1,
        },
        observed_at_ms: 2,
      },
      {
        type: "session_update",
        sessionId: "s1",
        update: {
          kind: "edit",
          toolCallId: "tc_read",
          toolName: "Read",
          status: "completed",
          raw_update: {
            sessionUpdate: "tool_call",
            toolCallId: "tc_read",
            title: "Read",
            kind: "read",
            status: "completed",
            rawInput: { file_path: probe },
          },
        },
        observed_at_ms: 3,
      },
      {
        type: "session_update",
        sessionId: "s1",
        update: {
          kind: "edit",
          toolCallId: "tc_write",
          toolName: "Write",
          status: "completed",
          raw_update: {
            sessionUpdate: "tool_call",
            toolCallId: "tc_write",
            title: "Write",
            kind: "edit",
            status: "completed",
            rawInput: { file_path: probe, content: "ok" },
          },
        },
        observed_at_ms: 4,
      },
    ];
    const hist = acp_events_to_history(events, { session_cwd: "/tmp" });
    const attempt = hist.find((e) => e.op === "probe.bypass_attempt");
    expect(attempt?.attrs?.tool_call_id).toBe("tc_write");
    expect(attempt?.attrs?.bypass_path_id).toBe("mode:default:Write");
  });

  it("same tool_call_id from attach + bind dedupes to one candidate (asked Bash)", () => {
    const probe = "/tmp/asa-auth08-p5.txt";
    const cmd = "echo 'p5-ok' > asa-auth08-p5.txt";
    const events: AcpPeerEvent[] = [
      {
        type: "session_update",
        sessionId: "s1",
        update: { kind: "session_new", cwd: "/tmp" },
        observed_at_ms: 1,
      },
      {
        type: "session_update",
        sessionId: "s1",
        update: {
          kind: "probe_bypass_attempt",
          bypass_path_id: "mode:default:Bash:redirect",
          path: probe,
          mechanism: "mode:default",
          runtime_generation: 1,
        },
        observed_at_ms: 2,
      },
      {
        type: "session_update",
        sessionId: "s1",
        update: {
          kind: "execute",
          toolCallId: "tc_bash",
          toolName: "Bash",
          status: "pending",
          raw_update: {
            sessionUpdate: "tool_call",
            toolCallId: "tc_bash",
            title: "Bash",
            kind: "execute",
            status: "pending",
            rawInput: { command: cmd },
          },
        },
        observed_at_ms: 3,
      },
      {
        type: "permission_request",
        sessionId: "s1",
        requestId: "1",
        toolName: "Bash",
        toolCallId: "tc_bash",
        input: { command: cmd },
        observed_at_ms: 4,
      },
      {
        type: "permission_response",
        sessionId: "s1",
        requestId: "1",
        decision: "allow",
        optionId: "allow-once",
        optionKind: "allow_once",
        observed_at_ms: 5,
      },
    ];
    const hist = acp_events_to_history(events, { session_cwd: "/tmp" });
    const attempt = hist.find((e) => e.op === "probe.bypass_attempt");
    expect(attempt?.attrs?.tool_call_id).toBe("tc_bash");
    expect(attempt?.attrs?.bypass_path_id).toBe("mode:default:Bash:redirect");
  });
});
