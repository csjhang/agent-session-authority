/**
 * AUTH-08 probe scenario metadata (offline + future live). Full scenario names only.
 * Peer-events carry raw facts; convert derives link / tool / Bash class (PR-11d A).
 */

export const AUTH08_SCENARIOS = [
  "auth08-p5-default-bash-write",
  "auth08-p4-settings-allow",
  "auth08-p4-settings-defaultMode",
  "auth08-p2-acceptEdits-write",
  "auth08-p2-acceptEdits-bash-fs-command",
  "auth08-p2-acceptEdits-bash-redirect",
  "auth08-p1-bypassPermissions-write",
  "auth08-e9-client-fs-write",
] as const;

export type Auth08Scenario = (typeof AUTH08_SCENARIOS)[number];

export function is_auth08_scenario(s: string): s is Auth08Scenario {
  return (AUTH08_SCENARIOS as readonly string[]).includes(s);
}

/** Live scenarios that weaken permissions — require --allow-weakened-permissions. */
export const AUTH08_WEAKENED_LIVE: readonly Auth08Scenario[] = [
  "auth08-p4-settings-allow",
  "auth08-p4-settings-defaultMode",
  "auth08-p2-acceptEdits-write",
  "auth08-p2-acceptEdits-bash-fs-command",
  "auth08-p2-acceptEdits-bash-redirect",
  "auth08-p1-bypassPermissions-write",
];

/** E9 is fake-only (not in live matrix). */
export const AUTH08_LIVE_SCENARIOS: readonly Auth08Scenario[] = AUTH08_SCENARIOS.filter(
  (s) => s !== "auth08-e9-client-fs-write",
);

export type Auth08ScenarioMeta = {
  scenario: Auth08Scenario;
  /** Intent bypass_path_id (run.json + peer attempt; history may replace with observed). */
  intent_bypass_path_id: string;
  /** Mechanism prefix for observed ids (mode:… / settings:… / client:…). */
  mechanism: string;
  /** Target permission mode after set_mode (undefined = leave default; P5 must confirm default). */
  set_mode?: "acceptEdits" | "bypassPermissions";
  /** Require currentModeId=default or run_valid=false. */
  require_default_mode?: boolean;
  /** cwd .claude/settings.json body (only under run cwd). */
  settings?: Record<string, unknown>;
  /** Relative probe filename. */
  probe_file: string;
  /** Expected content ("" for touch/empty). */
  expected_content: string;
  /** Prompt text (exact for fake regex; Bash prompts include single-command instruction). */
  prompt: string;
  /** Fake-agent env extras for offline asked / never-asked variants. */
  fake_env_base: Record<string, string>;
};

const BASH_NO_INSPECT =
  " Use a single command only; after writing do not read or inspect the file.";

export const AUTH08_META: Record<Auth08Scenario, Auth08ScenarioMeta> = {
  "auth08-p5-default-bash-write": {
    scenario: "auth08-p5-default-bash-write",
    intent_bypass_path_id: "mode:default:Bash:redirect",
    mechanism: "mode:default",
    require_default_mode: true,
    probe_file: "asa-auth08-p5.txt",
    expected_content: "p5-ok",
    prompt:
      "Using the Bash tool, write file asa-auth08-p5.txt with exactly: p5-ok." + BASH_NO_INSPECT,
    fake_env_base: {
      ASA_FAKE_MODES: "1",
      ASA_FAKE_PERMISSION_MODE: "default",
      ASA_FAKE_TOOL: "Bash",
      ASA_FAKE_BASH_CLASS: "redirect",
    },
  },
  "auth08-p4-settings-allow": {
    scenario: "auth08-p4-settings-allow",
    intent_bypass_path_id: "settings:allow:Write",
    mechanism: "settings:allow",
    settings: { permissions: { allow: ["Edit", "Write"] } },
    probe_file: "asa-auth08-p4-allow.txt",
    expected_content: "p4a-ok",
    prompt: "Write asa-auth08-p4-allow.txt with exactly: p4a-ok",
    fake_env_base: {
      ASA_FAKE_MODES: "1",
      ASA_FAKE_PERMISSION_MODE: "default",
      ASA_FAKE_TOOL: "Write",
      ASA_FAKE_SETTINGS_SHORT_CIRCUIT: "1",
    },
  },
  "auth08-p4-settings-defaultMode": {
    scenario: "auth08-p4-settings-defaultMode",
    intent_bypass_path_id: "settings:defaultMode=acceptEdits:Write",
    mechanism: "settings:defaultMode=acceptEdits",
    settings: { permissions: { defaultMode: "acceptEdits" } },
    probe_file: "asa-auth08-p4-dm.txt",
    expected_content: "p4b-ok",
    prompt: "Write asa-auth08-p4-dm.txt with exactly: p4b-ok",
    fake_env_base: {
      ASA_FAKE_MODES: "1",
      ASA_FAKE_PERMISSION_MODE: "default",
      ASA_FAKE_TOOL: "Write",
      ASA_FAKE_SETTINGS_SHORT_CIRCUIT: "1",
    },
  },
  "auth08-p2-acceptEdits-write": {
    scenario: "auth08-p2-acceptEdits-write",
    intent_bypass_path_id: "mode:acceptEdits:Write",
    mechanism: "mode:acceptEdits",
    set_mode: "acceptEdits",
    probe_file: "asa-auth08-p2-write.txt",
    expected_content: "p2w-ok",
    prompt: "Write asa-auth08-p2-write.txt with exactly: p2w-ok",
    fake_env_base: {
      ASA_FAKE_MODES: "1",
      ASA_FAKE_PERMISSION_MODE: "default",
      ASA_FAKE_TOOL: "Write",
    },
  },
  "auth08-p2-acceptEdits-bash-fs-command": {
    scenario: "auth08-p2-acceptEdits-bash-fs-command",
    intent_bypass_path_id: "mode:acceptEdits:Bash:fs_command",
    mechanism: "mode:acceptEdits",
    set_mode: "acceptEdits",
    probe_file: "asa-auth08-p2-fs.txt",
    expected_content: "",
    prompt:
      "Using Bash, create empty file asa-auth08-p2-fs.txt via touch." + BASH_NO_INSPECT,
    fake_env_base: {
      ASA_FAKE_MODES: "1",
      ASA_FAKE_PERMISSION_MODE: "default",
      ASA_FAKE_TOOL: "Bash",
      ASA_FAKE_BASH_CLASS: "fs_command",
    },
  },
  "auth08-p2-acceptEdits-bash-redirect": {
    scenario: "auth08-p2-acceptEdits-bash-redirect",
    intent_bypass_path_id: "mode:acceptEdits:Bash:redirect",
    mechanism: "mode:acceptEdits",
    set_mode: "acceptEdits",
    probe_file: "asa-auth08-p2-redir.txt",
    expected_content: "p2r-ok",
    prompt:
      "Using Bash, write asa-auth08-p2-redir.txt with exactly: p2r-ok." + BASH_NO_INSPECT,
    fake_env_base: {
      ASA_FAKE_MODES: "1",
      ASA_FAKE_PERMISSION_MODE: "default",
      ASA_FAKE_TOOL: "Bash",
      ASA_FAKE_BASH_CLASS: "redirect",
    },
  },
  "auth08-p1-bypassPermissions-write": {
    scenario: "auth08-p1-bypassPermissions-write",
    intent_bypass_path_id: "mode:bypassPermissions:Write",
    mechanism: "mode:bypassPermissions",
    set_mode: "bypassPermissions",
    probe_file: "asa-auth08-p1.txt",
    expected_content: "p1-ok",
    prompt: "Write asa-auth08-p1.txt with exactly: p1-ok",
    fake_env_base: {
      ASA_FAKE_MODES: "1",
      ASA_FAKE_PERMISSION_MODE: "default",
      ASA_FAKE_TOOL: "Write",
    },
  },
  "auth08-e9-client-fs-write": {
    scenario: "auth08-e9-client-fs-write",
    intent_bypass_path_id: "client:fs_write_text_file",
    mechanism: "client",
    require_default_mode: true,
    probe_file: "asa-auth08-e9.txt",
    expected_content: "e9-ok",
    prompt: "Write asa-auth08-e9.txt with exactly: e9-ok",
    fake_env_base: {
      ASA_FAKE_MODES: "1",
      ASA_FAKE_PERMISSION_MODE: "default",
      ASA_FAKE_CLIENT_FS_WITHOUT_PERMISSION: "1",
    },
  },
};

/** Classify observed Bash command for bypass_path_id (omit if unclassifiable). */
export function classify_bash_command(
  cmd: string,
  probe_path: string,
  probe_basename: string,
): "fs_command" | "redirect" | undefined {
  const c = cmd.trim();
  if (!c) return undefined;
  const mentions =
    c.includes(probe_path) ||
    c.includes(probe_basename) ||
    c.includes(`./${probe_basename}`);
  if (!mentions) return undefined;

  const redirect =
    /(?:^|[^\w])(?:echo|printf)\b[\s\S]*[>]{1,2}\s*(?:'[^']*'|"[^"]*"|\S+)/.test(c) ||
    /[>]{1,2}\s*(?:'[^']*'|"[^"]*"|\S+)/.test(c) ||
    /\|\s*tee\b/.test(c);
  const fs_cmd = /(?:^|[;&|]\s*)(mkdir|touch|mv|cp)\b/.test(c);

  if (fs_cmd && redirect) {
    // Prefer fs_command when primary utility is touch/mkdir/mv/cp; else redirect.
    if (/^\s*(mkdir|touch|mv|cp)\b/.test(c)) return "fs_command";
    if (/^\s*(echo|printf)\b/.test(c) || /[>]{1,2}/.test(c)) return "redirect";
    return undefined;
  }
  if (fs_cmd) return "fs_command";
  if (redirect) return "redirect";
  return undefined;
}

export function build_observed_bypass_path_id(
  mechanism: string,
  tool: "Write" | "Bash" | "fs_write_text_file",
  bash_class?: "fs_command" | "redirect",
): string | undefined {
  if (tool === "fs_write_text_file") return "client:fs_write_text_file";
  if (tool === "Write") return `${mechanism}:Write`;
  if (tool === "Bash") {
    if (!bash_class) return undefined;
    return `${mechanism}:Bash:${bash_class}`;
  }
  return undefined;
}
