import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  parseSshTransportUri,
  validatePort,
  type SshTransportTarget,
} from "@getpaseo/protocol/ssh-transport";

const inputSchema = z
  .object({ sshEndpoint: z.string().max(4096), url: z.string().url().max(16384) })
  .strict();
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const DEFAULT_LIMITS = {
  maxTunnels: 12,
  readyTimeoutMs: 12000,
  probeIntervalMs: 60,
  bindAttempts: 3,
};
interface Tunnel {
  port: number;
  close: () => void;
  alive: () => boolean;
}
interface ForwardTarget {
  ssh: SshTransportTarget;
  remotePort: number;
  remoteHost: string;
  url: URL;
  key: string;
}

export function parseRemoteWeb(value: unknown): ForwardTarget {
  const input = inputSchema.parse(value);
  const ssh = parseSshTransportUri(input.sshEndpoint);
  const url = new URL(input.url);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.username ||
    url.password
  )
    throw new Error(
      "Remote web forwarding requires a loopback HTTP(S) URL without embedded credentials.",
    );
  const remotePort = validatePort(url.port || (url.protocol === "https:" ? 443 : 80), "Web port");
  const remoteHost = url.hostname === "[::1]" ? "[::1]" : "127.0.0.1";
  const key = JSON.stringify([ssh.host, ssh.sshPort ?? 22, remoteHost, remotePort]);
  return { ssh, remotePort, remoteHost, url, key };
}

export function remoteWebSshArgs(target: ForwardTarget, port: number): string[] {
  const args = [
    "-N",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "LogLevel=DEBUG1",
  ];
  if (target.ssh.sshPort) args.push("-p", String(target.ssh.sshPort));
  args.push(
    "-L",
    `${target.url.hostname === "[::1]" ? "[::1]" : "127.0.0.1"}:${validatePort(port, "Local web port")}:${target.remoteHost}:${target.remotePort}`,
    target.ssh.host,
  );
  return args;
}

async function unusedPort(host: string): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a local web port"));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}
async function isListening(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const finish = (ready: boolean) => {
      socket.destroy();
      resolve(ready);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(100, () => finish(false));
  });
}
function stop(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 1000);
  timer.unref();
  child.once("exit", () => clearTimeout(timer));
}

interface Dependencies {
  start?: (args: string[]) => ChildProcess;
  unusedPort?: (host: string) => Promise<number>;
  isListening?: (port: number, host: string) => Promise<boolean>;
  delay?: (milliseconds: number) => Promise<unknown>;
  now?: () => number;
  limits?: Partial<typeof DEFAULT_LIMITS>;
}

/** Bounded app-lifetime SSH leases. No timer polling while the app is idle and
 * no transcript/files are copied to expose the original remote web interface. */
export class RemoteWebForwards {
  private readonly tunnels = new Map<string, Promise<Tunnel>>();
  private readonly children = new Set<ChildProcess>();
  private readonly limits: typeof DEFAULT_LIMITS;
  private generation = 0;
  constructor(private readonly dependencies: Dependencies = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...dependencies.limits };
  }
  async prepare(value: unknown): Promise<{ url: string }> {
    const target = parseRemoteWeb(value);
    let pending = this.tunnels.get(target.key);
    if (pending && !(await pending).alive()) {
      this.tunnels.delete(target.key);
      pending = undefined;
    }
    if (!pending) {
      if (this.tunnels.size >= this.limits.maxTunnels)
        throw new Error(
          "Too many remote web connections. Close an unused remote web connection before opening another.",
        );
      const generation = this.generation;
      pending = this.open(target).then((tunnel) => {
        if (generation !== this.generation || this.tunnels.get(target.key) !== pending) {
          tunnel.close();
          throw new Error("Remote web connection was closed during startup");
        }
        return tunnel;
      });
      this.tunnels.set(target.key, pending);
      pending.catch(() => {
        if (this.tunnels.get(target.key) === pending) this.tunnels.delete(target.key);
      });
    }
    const tunnel = await pending;
    const url = new URL(target.url);
    // Preserve the hostname for native TLS certificate and cookie checks.
    url.port = String(tunnel.port);
    return { url: url.toString() };
  }
  close(value: unknown): void {
    const target = parseRemoteWeb(value);
    const pending = this.tunnels.get(target.key);
    this.tunnels.delete(target.key);
    if (pending)
      void pending.then(
        (tunnel) => tunnel.close(),
        () => undefined,
      );
  }
  closeAll(): void {
    this.generation++;
    for (const child of this.children) stop(child);
    for (const pending of this.tunnels.values())
      void pending.then(
        (tunnel) => tunnel.close(),
        () => undefined,
      );
    this.tunnels.clear();
  }
  private async open(target: ForwardTarget): Promise<Tunnel> {
    let lastError: Error = new Error("SSH web forwarding could not start");
    for (let attempt = 0; attempt < this.limits.bindAttempts; attempt++) {
      const localHost = target.url.hostname === "[::1]" ? "::1" : "127.0.0.1";
      const port = await (this.dependencies.unusedPort ?? unusedPort)(localHost);
      const child = (
        this.dependencies.start ??
        ((args) => spawn("ssh", args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true }))
      )(remoteWebSshArgs(target, port));
      this.children.add(child);
      child.once("exit", () => this.children.delete(child));
      let failed = false;
      let forwardReady = false;
      let detail = "";
      const alive = () => !failed && child.exitCode === null && child.signalCode === null;
      child.stderr?.on("data", (chunk: Buffer) => {
        detail = `${detail}${chunk.toString()}`.slice(-4096);
        if (detail.includes(`Local forwarding listening on ${localHost} port ${port}`))
          forwardReady = true;
      });
      child.once("error", () => {
        failed = true;
      });
      child.once("exit", () => {
        failed = true;
      });
      const now = this.dependencies.now ?? Date.now;
      const deadline = now() + this.limits.readyTimeoutMs;
      while (alive() && now() < deadline) {
        if (
          forwardReady &&
          (await (this.dependencies.isListening ?? isListening)(port, localHost))
        ) {
          // ExitOnForwardFailure must also get a chance to report a bind race.
          await (this.dependencies.delay ?? delay)(this.limits.probeIntervalMs);
          if (alive()) return { port, alive, close: () => stop(child) };
          break;
        }
        await (this.dependencies.delay ?? delay)(this.limits.probeIntervalMs);
      }
      stop(child);
      if (/Permission denied/iu.test(detail))
        throw new Error(
          "SSH authentication failed. Reconnect this server before opening its web tool.",
        );
      if (/Host key verification failed/iu.test(detail))
        throw new Error(
          "SSH host verification failed. Verify this server through the existing server connection.",
        );
      lastError = new Error(
        "SSH web forwarding could not start. Check that this server is reachable and permits local port forwarding.",
      );
      if (!/Address already in use/iu.test(detail)) throw lastError;
    }
    throw lastError;
  }
}

export const remoteWebForwards = new RemoteWebForwards();
