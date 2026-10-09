import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";

import type { ProjectIcon } from "./project-icon.js";

const DISCOVERY_TIMEOUT_MS = 3_000;
const MAX_DISCOVERY_PROCESSES = 2;
const MAX_PENDING_DISCOVERIES = 64;
const MAX_RESPONSE_BYTES = 64 * 1024;

type Launch = (rootPath: string) => ChildProcess;
interface Discovery {
  rootPath: string;
  promise: Promise<ProjectIcon | null>;
  finish: (icon: ProjectIcon | null) => void;
  timer: ReturnType<typeof setTimeout>;
  child?: ChildProcess;
  settled: boolean;
}

// A macOS privacy prompt (or an unresponsive mounted directory) can block native
// readdir indefinitely. Async I/O in a worker thread still shares libuv's pool;
// a child process gives optional icon discovery its own filesystem workers.
export class ProjectIconDiscovery {
  private readonly pending = new Map<string, Discovery>();
  private readonly queue: Discovery[] = [];
  private running = 0;

  constructor(
    private readonly launch: Launch = launchDiscovery,
    private readonly timeoutMs = DISCOVERY_TIMEOUT_MS,
  ) {}

  read(rootPath: string): Promise<ProjectIcon | null> {
    const existing = this.pending.get(rootPath);
    if (existing) return existing.promise;
    if (this.pending.size >= MAX_PENDING_DISCOVERIES) return Promise.resolve(null);
    let resolve!: (icon: ProjectIcon | null) => void;
    const promise = new Promise<ProjectIcon | null>((done) => {
      resolve = done;
    });
    const entry: Discovery = {
      rootPath,
      promise,
      settled: false,
      finish: resolve,
      timer: setTimeout(() => this.settle(entry, null), this.timeoutMs),
    };
    this.pending.set(rootPath, entry);
    this.queue.push(entry);
    this.pump();
    return promise;
  }

  private settle(entry: Discovery, icon: ProjectIcon | null): void {
    if (entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timer);
    entry.finish(icon);
    if (entry.child) {
      // Do not reuse its process slot until close confirms that the native call
      // has stopped. Repeated requests cannot accumulate stuck child processes.
      entry.child.kill("SIGKILL");
      // A delayed native exit must not keep the daemon alive through its pipe
      // or process handle. The close listener still owns releasing the slot.
      entry.child.stdout?.destroy();
      entry.child.unref();
    } else {
      this.pending.delete(entry.rootPath);
      const index = this.queue.indexOf(entry);
      if (index >= 0) this.queue.splice(index, 1);
    }
  }

  private pump(): void {
    while (this.running < MAX_DISCOVERY_PROCESSES && this.queue.length) {
      const entry = this.queue.shift()!;
      this.start(entry);
    }
  }

  private start(entry: Discovery): void {
    let child: ChildProcess;
    try {
      child = this.launch(entry.rootPath);
    } catch {
      this.settle(entry, null);
      return;
    }
    entry.child = child;
    this.running += 1;
    let bytes = 0;
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => {
      if (entry.settled) return;
      bytes += chunk.length;
      if (bytes > MAX_RESPONSE_BYTES) this.settle(entry, null);
      else chunks.push(chunk);
    });
    child.once("error", () => this.settle(entry, null));
    child.once("close", (code) => {
      this.settle(entry, code === 0 ? parseIcon(Buffer.concat(chunks).toString("utf8")) : null);
      this.pending.delete(entry.rootPath);
      this.running -= 1;
      this.pump();
    });
  }
}

function parseIcon(output: string): ProjectIcon | null {
  try {
    const value: unknown = JSON.parse(output);
    if (!value || typeof value !== "object") return null;
    const icon = value as Record<string, unknown>;
    if (typeof icon.data !== "string" || typeof icon.mimeType !== "string") return null;
    if (!icon.mimeType.startsWith("image/") || icon.mimeType.length > 64) return null;
    return { data: icon.data, mimeType: icon.mimeType };
  } catch {
    return null;
  }
}

function launchDiscovery(rootPath: string): ChildProcess {
  // Node 24 can also load the erasable source module in the source test runner.
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const moduleUrl = new URL(`./project-icon.${extension}`, import.meta.url).href;
  return spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "const {getProjectIcon}=await import(process.argv[1]);process.stdout.write(JSON.stringify(await getProjectIcon(process.argv[2])));",
      moduleUrl,
      rootPath,
    ],
    {
      cwd: tmpdir(),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    },
  );
}

const discovery = new ProjectIconDiscovery();

export function discoverProjectIcon(rootPath: string): Promise<ProjectIcon | null> {
  return discovery.read(rootPath);
}
