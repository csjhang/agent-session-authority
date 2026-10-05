/** Live child-process spawn / stop for the target ACP agent. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

/**
 * PR-10c F (choice: explicit refusal, not Windows .cmd support).
 * On Windows the npm bin for claude-agent-acp is a .cmd shim. Spawning it correctly needs
 * cmd.exe (shell) quoting and a whole-process-tree kill (taskkill /T /F) — child.kill()
 * would only end cmd.exe and leave generation 1 alive across the "restart". The harness
 * does neither, so a .cmd/.bat command (including the bare default "claude-agent-acp")
 * is refused on win32 with a clear error before anything is spawned. Live probes belong in
 * a disposable Linux environment; direct executables (e.g. node + dist/index.js) still work.
 */
export function assert_live_command_supported(command: string, platform: string = process.platform): void {
  if (platform !== "win32") return;
  const base = path.win32.basename(command).toLowerCase();
  if (base !== "claude-agent-acp" && !base.endsWith(".cmd") && !base.endsWith(".bat")) return;
  throw new Error(
    `live ACP on Windows: refusing to spawn ${JSON.stringify(command)} — .cmd/.bat shims (including the default ` +
      `"claude-agent-acp" npm bin) are not supported by this harness (it would need cmd.exe quoting and a ` +
      `process-tree kill, taskkill /T /F, for the SIGTERM restart to really end generation 1). ` +
      `Run live probes in a disposable Linux environment (container/VM). On Windows, only a direct executable ` +
      `works, e.g. live_command=<node.exe> with live_args=[<claude-agent-acp dist/index.js>].`,
  );
}


export function has_key(env: NodeJS.ProcessEnv): boolean { return Boolean(env.ANTHROPIC_API_KEY); }
export function spawn_live(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<ChildProcessWithoutNullStreams> { assert_live_command_supported(command); return new Promise((resolve, reject) => { const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] }); child.once("error", reject); child.once("spawn", () => resolve(child)); }); }
export function stop(child: ChildProcessWithoutNullStreams): Promise<void> { return new Promise((resolve) => { if (child.exitCode !== null) return resolve(); const t = setTimeout(resolve, 500); child.once("exit", () => { clearTimeout(t); resolve(); }); try { child.kill("SIGTERM"); } catch { clearTimeout(t); resolve(); } }); }
