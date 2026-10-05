/** Live child-process spawn / stop for the target ACP agent. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export function has_key(env: NodeJS.ProcessEnv): boolean { return Boolean(env.ANTHROPIC_API_KEY); }
export function spawn_live(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<ChildProcessWithoutNullStreams> { return new Promise((resolve, reject) => { const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] }); child.once("error", reject); child.once("spawn", () => resolve(child)); }); }
export function stop(child: ChildProcessWithoutNullStreams): Promise<void> { return new Promise((resolve) => { if (child.exitCode !== null) return resolve(); const t = setTimeout(resolve, 500); child.once("exit", () => { clearTimeout(t); resolve(); }); try { child.kill("SIGTERM"); } catch { clearTimeout(t); resolve(); } }); }
