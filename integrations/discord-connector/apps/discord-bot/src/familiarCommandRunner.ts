import { spawn } from "node:child_process";
import path from "node:path";

export interface FamiliarCommandRunner { (args: string[], timeoutMs: number): Promise<unknown> }
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const KILL_GRACE_MS = 1000;

/** The bot owns only these CLI transports, never the remote agent's lifetime. */
export function createFamiliarCommandRunner(cliPath: string): FamiliarCommandRunner & { close(): Promise<void> } {
  if (!path.isAbsolute(cliPath)) throw new Error("FamiliarAgent CLI path must be absolute");
  const active = new Set<{ controller: AbortController; task: Promise<unknown> }>();
  let closed = false;
  const run: FamiliarCommandRunner = (args, timeoutMs) => {
    if (closed) return Promise.reject(new Error("FamiliarAgent connector is closing"));
    const controller = new AbortController();
    const task = execute(cliPath, args, timeoutMs, controller.signal);
    const entry = { controller, task };
    active.add(entry);
    void task.finally(() => active.delete(entry)).catch(() => {});
    return task;
  };
  return Object.assign(run, {
    async close() {
      closed = true;
      const pending = [...active];
      for (const entry of pending) entry.controller.abort();
      await Promise.allSettled(pending.map(entry => entry.task));
    },
  });
}

function execute(cliPath: string, args: string[], timeoutMs: number, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(cliPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    const chunks: Buffer[] = [];
    let bytes = 0, errors = "", failure: Error | undefined, settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let finishFailedClose: (() => void) | undefined;
    const kill = (kind: NodeJS.Signals) => {
      if (!child.pid) return;
      try { if (process.platform !== "win32") process.kill(-child.pid, kind); else child.kill(kind); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(kind); }
    };
    const stop = (error: Error) => {
      if (settled || failure) return;
      failure = error;
      kill("SIGTERM");
      killTimer = setTimeout(() => { kill("SIGKILL"); killTimer = undefined; finishFailedClose?.(); }, KILL_GRACE_MS);
    };
    const aborted = () => stop(new Error("FamiliarAgent connector stopped. The native operation may still be running; inspect its original state."));
    signal.addEventListener("abort", aborted, { once: true });
    const timer = setTimeout(() => stop(new Error("FamiliarAgent request timed out. The native operation may still be running; use !fa status before retrying.")), timeoutMs);
    const cleanup = () => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); signal.removeEventListener("abort", aborted); };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; cleanup();
      if (error) { reject(error); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("FamiliarAgent returned invalid JSON")); }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure || settled) return;
      bytes += chunk.length;
      if (bytes > MAX_RESPONSE_BYTES) stop(new Error("FamiliarAgent response exceeds 8 MiB"));
      else chunks.push(chunk);
    });
    child.stderr.on("data", chunk => { if (!failure && !settled) errors = (errors + chunk.toString()).slice(-4096); });
    child.on("error", () => finish(new Error("FamiliarAgent CLI could not start. Check its executable path.")));
    child.on("close", code => {
      const error = failure ?? (code === 0 ? undefined : new Error(`FamiliarAgent failed (${code}). ${errors || Buffer.concat(chunks).toString("utf8").slice(-4096)}`));
      if (failure && killTimer) {
        clearTimeout(timer); signal.removeEventListener("abort", aborted);
        finishFailedClose = () => finish(error);
      } else finish(error);
    });
    if (signal.aborted) aborted();
  });
}
