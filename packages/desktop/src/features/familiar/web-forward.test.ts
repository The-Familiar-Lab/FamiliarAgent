import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { parseRemoteWeb, remoteWebSshArgs, RemoteWebForwards } from "./web-forward.js";

function child() {
  const process = new EventEmitter() as ChildProcess;
  Object.assign(process, {
    exitCode: null,
    signalCode: null,
    stderr: new PassThrough(),
    kill: vi.fn((signal: NodeJS.Signals) => {
      Object.assign(process, { signalCode: signal });
      process.emit("exit", null, signal);
      return true;
    }),
  });
  return process;
}
function fixture(options: { maxTunnels?: number; listening?: boolean } = {}) {
  let now = 0;
  const processes: ChildProcess[] = [];
  const start = vi.fn((args: string[]) => {
    const process = child();
    processes.push(process);
    const binding = args[args.indexOf("-L") + 1]!;
    const match = binding.match(/^(127\.0\.0\.1|\[::1\]):(\d+):/u)!;
    queueMicrotask(() =>
      process.stderr!.emit(
        "data",
        Buffer.from(
          `debug1: Local forwarding listening on ${match[1] === "[::1]" ? "::1" : match[1]} port ${match[2]}.\n`,
        ),
      ),
    );
    return process;
  });
  const forwards = new RemoteWebForwards({
    start,
    unusedPort: async () => 42000 + processes.length,
    isListening: async () => options.listening ?? true,
    now: () => now,
    delay: async (milliseconds) => {
      now += milliseconds;
    },
    limits: { readyTimeoutMs: 100, probeIntervalMs: 10, maxTunnels: options.maxTunnels ?? 12 },
  });
  return { forwards, start, processes };
}
const source = {
  sshEndpoint: "ssh://mingi@example-host:2222?daemonPort=6787",
  url: "http://127.0.0.1:7434/project?id=A%2FB#chat",
};

describe("remote native web forwarding", () => {
  it("uses strict validated SSH arguments without shell commands", () => {
    const args = remoteWebSshArgs(parseRemoteWeb(source), 42000);
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("ExitOnForwardFailure=yes");
    expect(args.slice(-5)).toEqual([
      "-p",
      "2222",
      "-L",
      "127.0.0.1:42000:127.0.0.1:7434",
      "mingi@example-host",
    ]);
    expect(args).toContain("-N");
  });
  it("preserves native path, query and fragment, reuses simultaneous leases and cleans up", async () => {
    const f = fixture();
    const [a, b] = await Promise.all([
      f.forwards.prepare(source),
      f.forwards.prepare({ ...source, url: "http://127.0.0.1:7434/settings" }),
    ]);
    expect(a.url).toBe("http://127.0.0.1:42000/project?id=A%2FB#chat");
    expect(b.url).toBe("http://127.0.0.1:42000/settings");
    expect(f.start).toHaveBeenCalledTimes(1);
    f.forwards.closeAll();
    expect(f.processes[0]!.kill).toHaveBeenCalledWith("SIGTERM");
  });
  it("keeps TLS hostnames and IPv6 loopback addresses", async () => {
    const f = fixture();
    expect((await f.forwards.prepare({ ...source, url: "https://localhost:9443/a" })).url).toBe(
      "https://localhost:42000/a",
    );
    const target = parseRemoteWeb({ ...source, url: "https://[::1]:9443/a" });
    expect(remoteWebSshArgs(target, 42001)).toContain("[::1]:42001:[::1]:9443");
    expect((await f.forwards.prepare({ ...source, url: "https://[::1]:9443/a" })).url).toBe(
      "https://[::1]:42001/a",
    );
    f.forwards.closeAll();
  });
  it.each([
    "https://example.com",
    "http://0.0.0.0:80",
    "http://169.254.169.254/",
    "file:///etc/passwd",
    "http://user:secret@localhost:80",
  ])("rejects non-loopback or credential-bearing URL %s", (url) => {
    expect(() => parseRemoteWeb({ ...source, url })).toThrow();
  });
  it("rejects SSH credentials, arguments and invalid ports", () => {
    for (const endpoint of [
      "ssh://user:secret@host",
      "ssh://-oProxyCommand=bad",
      "ssh://host:0",
      "ssh://host?arbitrary=1",
    ])
      expect(() => parseRemoteWeb({ ...source, sshEndpoint: endpoint })).toThrow();
  });
  it("requires HTTP only for the optional original-Host proxy and isolates its lease", () => {
    expect(() =>
      parseRemoteWeb({ ...source, preserveHost: true, url: "https://localhost:9443" }),
    ).toThrow("HTTP local");
    expect(parseRemoteWeb({ ...source, preserveHost: true }).key).not.toBe(
      parseRemoteWeb(source).key,
    );
    expect(parseRemoteWeb({ ...source, preserveHost: true }).key).not.toContain("A%2FB");
  });
  it("closes a proxy immediately when its SSH process exits and permits a new lease", async () => {
    const f = fixture();
    const input = { ...source, preserveHost: true };
    const first = await f.forwards.prepare(input);
    expect(new URL(first.url).pathname).toBe("/project");
    expect(new URL(first.url).search).toBe("?id=A%2FB");
    expect(new URL(first.url).hash).toBe("#chat");
    f.processes[0]!.kill("SIGTERM");
    await expect(fetch(first.url)).rejects.toThrow();
    const second = await f.forwards.prepare(input);
    expect(f.start).toHaveBeenCalledTimes(2);
    f.forwards.close(input);
    await Promise.resolve();
    await expect(fetch(second.url)).rejects.toThrow();
  });
  it("bounds live processes and permits explicit release", async () => {
    const f = fixture({ maxTunnels: 1 });
    await f.forwards.prepare(source);
    await expect(f.forwards.prepare({ ...source, url: "http://localhost:9999" })).rejects.toThrow(
      "Too many",
    );
    f.forwards.close(source);
    await Promise.resolve();
    expect(f.processes[0]!.kill).toHaveBeenCalled();
    await f.forwards.prepare({ ...source, url: "http://localhost:9999" });
    f.forwards.closeAll();
  });
  it("kills failed startup and never returns a local URL on SSH failure", async () => {
    const f = fixture({ listening: false });
    await expect(f.forwards.prepare(source)).rejects.toThrow("could not start");
    expect(f.processes[0]!.kill).toHaveBeenCalled();
    f.forwards.closeAll();
  });
  it("kills pending processes immediately during app shutdown", async () => {
    let proceed!: () => void;
    const waiting = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    const process = child();
    const forwards = new RemoteWebForwards({
      start: () => process,
      unusedPort: async () => 42000,
      isListening: async () => {
        await waiting;
        return true;
      },
      delay: async () => undefined,
    });
    const pending = forwards.prepare(source);
    await Promise.resolve();
    await Promise.resolve();
    forwards.closeAll();
    expect(process.kill).toHaveBeenCalled();
    proceed();
    await expect(pending).rejects.toThrow();
  });
});
