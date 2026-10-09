import { Worker } from "node:worker_threads";
import type { ProjectRootWatch, ProjectRootWatcher } from "./workspace-reconciliation-service.js";

const WATCH_SETUP_TIMEOUT_MS = 10_000;
const WATCH_RETRY_DELAY_MS = 60_000;

// Keep the native open off the daemon thread: macOS can wait inside fs.watch
// for a Documents permission decision, preventing even JS timers from firing.
function watchWorkerMain(): void {
  const { parentPort } = process.getBuiltinModule("node:worker_threads");
  const { watch } = process.getBuiltinModule("node:fs");
  const watchers = new Map<number, ReturnType<typeof watch>>();
  parentPort!.on("message", (message: { id: number; root?: string }) => {
    if (!message.root) {
      watchers.get(message.id)?.close();
      watchers.delete(message.id);
      return;
    }
    try {
      const watcher = watch(message.root, { recursive: false }, (event, filename) => {
        parentPort!.postMessage({ id: message.id, event, filename }, []);
      });
      watchers.set(message.id, watcher);
      watcher.on("error", (error) => {
        watcher.close();
        watchers.delete(message.id);
        parentPort!.postMessage({ id: message.id, error: error.message }, []);
      });
      parentPort!.postMessage({ id: message.id, ready: true }, []);
    } catch (error) {
      parentPort!.postMessage({ id: message.id, error: String(error) }, []);
    }
  });
}

interface WatchEntry {
  ready: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolve(watcher: ProjectRootWatcher): void;
  reject(error: Error): void;
  onChange: Parameters<ProjectRootWatch>[2];
  onError: Parameters<ProjectRootWatch>[3];
}

/** One worker per reconciler, regardless of project count. No polling in the worker. */
export class ProjectRootWatchWorker {
  private worker: Worker | null = null;
  private readonly entries = new Map<number, WatchEntry>();
  private nextId = 0;
  private stopped = false;
  private quarantined = false;
  private retryAfter = 0;

  constructor(
    private readonly createWorker = () =>
      new Worker(`(${watchWorkerMain.toString()})()`, { eval: true, execArgv: [] }),
    private readonly timeoutMs = WATCH_SETUP_TIMEOUT_MS,
  ) {}

  readonly watch: ProjectRootWatch = (root, _options, onChange, onError) => {
    const worker = this.ensureWorker();
    const id = ++this.nextId;
    return new Promise<ProjectRootWatcher>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failWorker(
          new Error(
            "Project folder watch timed out. Check FamiliarAgent's Files and Folders permission in macOS System Settings. Background checks will retry.",
          ),
        );
      }, this.timeoutMs);
      this.entries.set(id, { ready: false, timer, resolve, reject, onChange, onError });
      try {
        worker.postMessage({ id, root }, []);
      } catch (error) {
        this.entries.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  };

  dispose(): void {
    this.stopped = true;
    this.failWorker(new Error("Project root watcher is closed"));
  }

  private ensureWorker(): Worker {
    if (this.stopped) throw new Error("Project root watcher is closed");
    if (this.quarantined || Date.now() < this.retryAfter)
      throw new Error("Project folder access is still waiting for the operating system");
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    this.worker = worker;
    worker.on("message", (message) => this.receive(message));
    worker.on("error", (error) => this.failWorker(error));
    worker.on("exit", () => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.quarantined = false;
      this.failEntries(new Error("Project root watch worker exited"));
    });
    worker.unref();
    return worker;
  }

  private receive(message: {
    id: number;
    ready?: boolean;
    error?: string;
    event?: string;
    filename?: string | null;
  }): void {
    const entry = this.entries.get(message.id);
    if (!entry) return;
    if (message.error) {
      this.entries.delete(message.id);
      clearTimeout(entry.timer);
      const error = new Error(message.error);
      if (entry.ready) entry.onError(error);
      else entry.reject(error);
    } else if (message.ready) {
      clearTimeout(entry.timer);
      entry.ready = true;
      entry.resolve({
        close: () => {
          if (!this.entries.delete(message.id)) return;
          this.worker?.postMessage({ id: message.id }, []);
        },
      });
    } else if (entry.ready && message.event) {
      entry.onChange(message.event, message.filename ?? null);
    }
  }

  private failEntries(error: Error): void {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      if (entry.ready) entry.onError(error);
      else entry.reject(error);
    }
  }

  private failWorker(error: Error): void {
    // A blocked syscall may delay terminate(). Keep at most this one worker
    // quarantined until exit instead of accumulating a worker per retry/root.
    this.quarantined = this.worker !== null;
    this.retryAfter = Date.now() + WATCH_RETRY_DELAY_MS;
    this.failEntries(error);
    this.worker?.unref();
    if (this.worker) void this.stopWorker(this.worker);
  }

  private async stopWorker(worker: Worker): Promise<void> {
    try {
      await worker.terminate();
    } catch {
      // Remain quarantined until the exit event confirms cleanup.
    }
  }
}
