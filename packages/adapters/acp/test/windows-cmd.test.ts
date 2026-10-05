/**
 * PR-10c F — choice: on Windows, a .cmd/.bat live_command (including the default
 * "claude-agent-acp" npm shim) is refused with a clear error pointing to a disposable
 * Linux environment, instead of half-supporting it (no cmd.exe quoting, no taskkill /T /F
 * tree kill → gen1 could survive the "restart"). Direct executables keep working.
 * Offline: nothing is spawned for a refused command.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collect_history } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fake_agent = path.join(here, "fixtures", "fake-acp-agent.mjs");
const REFUSED = /refusing to spawn .*\.cmd\/\.bat shims .*disposable Linux environment/s;

function live_opts(cwd: string, live_command?: string) {
  return {
    mode: "live" as const,
    scenario: "mid-write-restart" as const,
    cwd,
    ...(live_command !== undefined ? { live_command } : {}),
    live_args: [fake_agent],
    env: { ...process.env, ANTHROPIC_API_KEY: "offline-fake-agent-placeholder" },
    effect_grace_ms: 1500,
    always_grant_poll_ms: 1500,
    live_observe_ms: 5000,
  };
}

async function as_platform<T>(platform: string, fn: () => Promise<T>): Promise<T> {
  const desc = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return await fn();
  } finally {
    if (desc) Object.defineProperty(process, "platform", desc);
  }
}

describe("Windows .cmd/.bat live_command → clear refusal", () => {
  it("assert_live_command_supported: win32 shims refused; direct executables and non-Windows allowed", async () => {
    const { assert_live_command_supported } = await import("../src/spawn.js");
    for (const cmd of [
      "claude-agent-acp",
      "claude-agent-acp.cmd",
      "C:\\Users\\me\\AppData\\Roaming\\npm\\claude-agent-acp.CMD",
      "C:\\Program Files\\tools\\agent wrapper.bat",
      "C:\\tools\\Claude-Agent-ACP",
    ]) {
      expect(() => assert_live_command_supported(cmd, "win32"), cmd).toThrow(REFUSED);
    }
    for (const cmd of ["C:\\Program Files\\nodejs\\node.exe", "node", "claude-agent-acp.exe"]) {
      expect(() => assert_live_command_supported(cmd, "win32"), cmd).not.toThrow();
    }
    for (const cmd of ["claude-agent-acp", "/usr/local/bin/claude-agent-acp", "agent.cmd"]) {
      expect(() => assert_live_command_supported(cmd, "linux"), cmd).not.toThrow();
    }
  });

  it("collect_history on win32 with a .cmd live_command rejects with the Linux pointer (no spawn ENOENT/EINVAL)", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "asa-pr10c-f-"));
    await as_platform("win32", async () => {
      await expect(collect_history(live_opts(cwd, "C:\\Users\\me\\AppData\\Roaming\\npm\\claude-agent-acp.cmd"))).rejects.toThrow(REFUSED);
      // Default command is the npm shim on Windows → same refusal.
      await expect(collect_history(live_opts(cwd))).rejects.toThrow(REFUSED);
    });
  });

  it.skipIf(process.platform !== "win32")(
    "Windows CI: a real .cmd wrapper (path with a space) around the fake agent is refused; node + script still runs",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asa pr10c f "));
      const cmd = path.join(dir, "fake agent.cmd");
      fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${fake_agent}" %*\r\n`);
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "asa-pr10c-f-win-"));
      await expect(collect_history({ ...live_opts(cwd, cmd), live_args: [] })).rejects.toThrow(REFUSED);
      const ok = await collect_history({ ...live_opts(cwd, process.execPath) });
      expect(ok.run_valid).toBe(true);
    },
    60_000,
  );
});
