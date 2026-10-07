/**
 * AUTH-08 single-generation probe runs (P5 → P4 → P2×3 → P1 + E9 fake-only).
 * Isolation + safety flags; peer-events = raw facts only (PR-11d A).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { observe_event } from "./mock_peer.js";
import { wait_for_write_effect } from "./effect_wait.js";
import { live_history_from_peer_events } from "./history_from_acp.js";
import {
  PINNED,
  build_session_new,
  build_session_prompt,
  build_session_set_mode,
} from "./protocol.js";
import { spawn_live, stop } from "./spawn.js";
import { agent_info_version, initialize } from "./live_rpc.js";
import type { LiveRunOutput } from "./live_run_ctx.js";
import type { AcpAdapterOptions } from "./types.js";
import {
  AUTH08_META,
  AUTH08_WEAKENED_LIVE,
  type Auth08Scenario,
  is_auth08_scenario,
} from "./auth08_scenarios.js";

export type Auth08RunExtras = {
  /** Populated into run.json by write_live_run callers / tests. */
  auth08_run_json?: Record<string, unknown>;
};

function repo_root_from_here(): string {
  // packages/adapters/acp/src → repo root
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
}

function is_path_inside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function dir_is_empty(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

export function assert_auth08_live_safety(
  scenario: Auth08Scenario,
  cwd: string,
  opts: { allow_weakened_permissions?: boolean; live_command?: string },
): void {
  const repo = repo_root_from_here();
  if (is_path_inside(cwd, repo)) {
    throw new Error(
      `AUTH-08 refuse: cwd ${cwd} is inside the repo (${repo}); use an empty temp directory outside the repo`,
    );
  }
  if (!dir_is_empty(cwd)) {
    throw new Error(`AUTH-08 refuse: cwd ${cwd} is not empty`);
  }
  const weakened = (AUTH08_WEAKENED_LIVE as readonly string[]).includes(scenario);
  // Real agent (not fake node fixture): require explicit weakened flag for P4/P2/P1.
  const is_fake =
    typeof opts.live_command === "string" &&
    (opts.live_command.includes("fake-acp-agent") ||
      opts.live_command === process.execPath ||
      opts.live_command.endsWith("/node") ||
      opts.live_command.endsWith("\\node.exe"));
  if (weakened && !opts.allow_weakened_permissions && !is_fake) {
    throw new Error(
      `AUTH-08 refuse: scenario ${scenario} weakens permissions; pass --allow-weakened-permissions`,
    );
  }
}

function sha256_json(obj: unknown): string {
  return createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}

function current_mode_from_session_new(response: Record<string, unknown> | undefined): string | undefined {
  const result = response?.result as Record<string, unknown> | undefined;
  if (!result) return undefined;
  const modes = result.modes as Record<string, unknown> | undefined;
  if (modes && typeof modes.currentModeId === "string") return modes.currentModeId;
  const opts = result.configOptions as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(opts)) {
    const mode = opts.find((o) => o.id === "mode" || o.category === "mode");
    if (mode && typeof mode.currentValue === "string") return mode.currentValue;
  }
  return undefined;
}

export async function run_auth08_probe(
  opts: AcpAdapterOptions,
  notes: string[],
  scenario: Auth08Scenario,
): Promise<LiveRunOutput & Auth08RunExtras> {
  if (!is_auth08_scenario(scenario)) {
    throw new Error(`not an AUTH-08 scenario: ${scenario}`);
  }
  const meta = AUTH08_META[scenario];
  const events: import("./mock_peer.js").AcpPeerEvent[] = [];
  const invalid_reasons: string[] = [];
  let package_version_observed: string | undefined;
  const env_in = opts.env ?? process.env;

  // Isolation: empty temp cwd outside repo + CLAUDE_CONFIG_DIR empty temp.
  const cwd =
    opts.cwd !== undefined
      ? path.resolve(opts.cwd)
      : fs.mkdtempSync(path.join(os.tmpdir(), "asa-auth08-cwd-"));
  const claude_config_dir = fs.mkdtempSync(path.join(os.tmpdir(), "asa-auth08-claude-"));

  try {
    assert_auth08_live_safety(scenario, cwd, {
      allow_weakened_permissions: opts.allow_weakened_permissions,
      live_command: opts.live_command,
    });
  } catch (e) {
    invalid_reasons.push(String(e instanceof Error ? e.message : e));
    notes.push(`RUN INVALID: ${invalid_reasons[0]}`);
    return {
      events,
      history: live_history_from_peer_events(events),
      package_version_observed,
      invalid_reasons,
      auth08_run_json: { isolation: { refused: true } },
    };
  }

  let settings_path: string | undefined;
  let settings_body: Record<string, unknown> | undefined;
  let settings_sha256: string | undefined;
  if (meta.settings) {
    const claude_dir = path.join(cwd, ".claude");
    fs.mkdirSync(claude_dir, { recursive: true });
    settings_path = path.join(claude_dir, "settings.json");
    settings_body = meta.settings;
    fs.writeFileSync(settings_path, JSON.stringify(settings_body, null, 2) + "\n");
    settings_sha256 = sha256_json(settings_body);
    // Raw settings peer fact
    events.push(
      observe_event({
        type: "session_update",
        sessionId: "pre-session",
        update: {
          kind: "auth08_settings",
          path: settings_path,
          body: settings_body,
          sha256: settings_sha256,
        },
      }),
    );
  }

  const env: NodeJS.ProcessEnv = {
    ...env_in,
    CLAUDE_CONFIG_DIR: claude_config_dir,
    ...meta.fake_env_base,
    ...(opts.env ?? {}),
  };
  // Re-apply caller env overrides after fake_env_base so tests can set NEVER_ASK etc.
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (v !== undefined) env[k] = v;
    }
    env.CLAUDE_CONFIG_DIR = claude_config_dir;
  }

  const timeout = opts.live_observe_ms ?? 4000;
  const effect_grace_ms = opts.effect_grace_ms ?? 20_000;
  const WRITE_PROBE_PROMPT_MS = 180_000;
  const command = opts.live_command ?? "claude-agent-acp";
  const args = opts.live_args ?? [];
  const probe_file = meta.probe_file;
  const probe_abs = path.resolve(cwd, probe_file);
  const expected = meta.expected_content;

  notes.push(
    `AUTH-08 ${scenario}: isolation CLAUDE_CONFIG_DIR=${claude_config_dir} cwd=${cwd}`,
  );
  notes.push(`target-file approach: fixed probe name ${probe_file} under disposable cwd`);

  const c1 = await spawn_live(command, args, env);
  const i1 = await initialize(c1, events, notes, timeout, "allow", cwd);
  const finish = (extra_notes: string[] = [], auth08_run_json?: Record<string, unknown>) => {
    for (const n of extra_notes) notes.push(n);
    const history = live_history_from_peer_events(events);
    return {
      events,
      history,
      package_version_observed,
      invalid_reasons,
      auth08_run_json,
    };
  };

  if (!i1.result) {
    const reason = "initialize returned no result";
    invalid_reasons.push(reason);
    notes.push(`RUN INVALID: ${reason} — no prompt was sent`);
    await stop(c1);
    return finish();
  }
  {
    const ver = agent_info_version(i1.result);
    package_version_observed = ver;
    if (ver !== PINNED) {
      const reason = `claude-agent-acp agentInfo.version=${ver ?? "missing"} != pinned ${PINNED}`;
      invalid_reasons.push(reason);
      notes.push(`RUN INVALID: ${reason} — no prompt was sent`);
      await stop(c1);
      return finish();
    }
    notes.push(`agentInfo.version=${PINNED} matches pin ${PINNED}`);
  }

  const n = await i1.rpc.request(build_session_new(3, cwd), timeout);
  const sid = String((n.result as Record<string, unknown> | undefined)?.sessionId ?? "live-session");
  i1.rpc.set_session(sid);
  events.push(
    observe_event({
      type: "session_update",
      sessionId: sid,
      update: { kind: "session_new", cwd, response: n },
    }),
  );

  let reported_mode = current_mode_from_session_new(n as Record<string, unknown>);
  notes.push(`session/new currentModeId=${reported_mode ?? "missing"}`);

  // set_mode when required
  if (meta.set_mode) {
    const mode_id = i1.rpc.next_id();
    events.push(
      observe_event({
        type: "session_update",
        sessionId: sid,
        update: { kind: "set_mode_request", modeId: meta.set_mode, request_id: mode_id },
      }),
    );
    const sm = await i1.rpc.request(build_session_set_mode(mode_id, sid, meta.set_mode), timeout);
    events.push(
      observe_event({
        type: "session_update",
        sessionId: sid,
        update: { kind: "set_mode_response", modeId: meta.set_mode, response: sm },
      }),
    );
    if ("error" in sm) {
      const reason = `session/set_mode ${meta.set_mode} rejected: ${JSON.stringify(sm.error)}`;
      invalid_reasons.push(reason);
      notes.push(`RUN INVALID: ${reason}`);
      await stop(c1);
      return finish([], auth08_stamp());
    }
    // Prefer current_mode_update from agent; else trust set_mode success for fake.
    reported_mode = meta.set_mode;
    events.push(
      observe_event({
        type: "session_update",
        sessionId: sid,
        update: { kind: "probe_permission_mode", permission_mode: reported_mode },
      }),
    );
    notes.push(`set_mode → ${meta.set_mode}`);
  } else if (reported_mode) {
    events.push(
      observe_event({
        type: "session_update",
        sessionId: sid,
        update: { kind: "probe_permission_mode", permission_mode: reported_mode },
      }),
    );
  }

  if (meta.require_default_mode) {
    if (reported_mode !== "default") {
      const reason = `P5/E9 require currentModeId=default, got ${reported_mode ?? "missing"}`;
      invalid_reasons.push(reason);
      notes.push(`RUN INVALID: ${reason}`);
      await stop(c1);
      return finish([], auth08_stamp());
    }
  }

  function auth08_stamp(): Record<string, unknown> {
    return {
      scenario,
      probe_intent_bypass_path_id: meta.intent_bypass_path_id,
      probe_path: probe_abs,
      probe_file,
      expected_content: expected,
      mechanism: meta.mechanism,
      reported_mode: reported_mode ?? null,
      claude_config_dir,
      cwd,
      settings_path: settings_path ?? null,
      settings_sha256: settings_sha256 ?? null,
      settings_body: settings_body ?? null,
      isolation: {
        user_claude_bypassed: true,
        method: "CLAUDE_CONFIG_DIR+cwd_temp",
      },
    };
  }

  // Attempt peer at prompt-send (raw facts: mechanism, path, intent id) — before any turn events.
  events.push(
    observe_event({
      type: "session_update",
      sessionId: sid,
      update: {
        kind: "probe_bypass_attempt",
        bypass_path_id: meta.intent_bypass_path_id,
        path: probe_abs,
        mechanism: meta.mechanism,
        runtime_generation: 1,
      },
    }),
  );

  const write_prompt_timeout = Math.max(timeout, WRITE_PROBE_PROMPT_MS);
  const events_before_prompt = events.length;
  const p1 = await i1.rpc.request(
    build_session_prompt(i1.rpc.next_id(), sid, meta.prompt),
    write_prompt_timeout,
  );
  events.push(
    observe_event({
      type: "session_update",
      sessionId: sid,
      update: {
        kind: "prompt_result",
        prompt: scenario,
        response: p1,
        effect_path: probe_file,
        effect_content: expected,
        prompt_timeout_ms: write_prompt_timeout,
      },
    }),
  );

  await wait_for_write_effect(probe_file, events, notes, {
    grace_ms: effect_grace_ms,
    label: `auth08:${probe_file}`,
    // Empty string expected (touch): match empty file; undefined skips content check.
    expected,
    sessionId: sid,
    cwd,
    since_index: events_before_prompt,
  });

  // Escape check: probe must stay under cwd
  if (fs.existsSync(probe_abs)) {
    const rel = path.relative(cwd, probe_abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      invalid_reasons.push(`probe path escaped cwd: ${probe_abs}`);
    }
  }

  notes.push(
    `client fs: write_text_file performed=${i1.rpc.fs_write_performed} read_text_file served=${i1.rpc.fs_read_served}`,
  );
  await stop(c1);
  return finish([], auth08_stamp());
}
